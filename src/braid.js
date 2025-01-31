/**
 * This module provides functions for braids, which is how we define
 * a group of xpubs with some additional multisig information to define
 * a multisig setup. Sometimes, the word `wallet` is used here, but we
 * view the traditional use of the word 'wallet' as a collection of Braids.
 *
 * @module braid
 */

import { Struct } from "bufio";
import assert from "assert";
import {
  bip32PathToSequence,
  validateBIP32Index,
  validateBIP32Path,
} from "./paths";
import { NETWORKS } from "./networks";
import {
  MULTISIG_ADDRESS_TYPES,
  generateMultisigFromPublicKeys,
} from "./multisig";
import {
  validateExtendedPublicKey,
  deriveChildPublicKey,
  extendedPublicKeyRootFingerprint,
} from "./keys";

// In building the information objects that PSBTs want, one must include information
// about the root fingerprint for the device. If that information is unknown, just fill
// it in with zeros.
const FAKE_ROOT_FINGERPRINT = "00000000";

/**
 * Struct object for encoding and decoding braids.
 *
 * @param {string} options.network = mainnet - mainnet or testnet
 * @param {string} options.addressType P2SH, P2SH-P2WSH, P2WSH
 * @param {ExtendedPublicKey[]} options.extendedPublicKeys ExtendedPublicKeys that make up this braid
 * @param {number} options.requiredSigners - how many required signers in this braid
 * @param {string} options.index - One value, relative, to add on to all xpub absolute bip32paths (usually 0=deposit, 1=change)
 */
export class Braid extends Struct {
  constructor(options) {
    super();
    if (!options || !Object.keys(options).length) {
      return this;
    }

    assert(
      Object.values(MULTISIG_ADDRESS_TYPES).includes(options.addressType),
      `Expected addressType to be one of:  ${Object.values(
        MULTISIG_ADDRESS_TYPES
      )}. You sent ${options.addressType}`
    );
    this.addressType = options.addressType;
    assert(
      Object.values(NETWORKS).includes(options.network),
      `Expected network to be one of:  ${NETWORKS}.`
    );
    this.network = options.network;

    options.extendedPublicKeys.forEach((xpub) => {
      const xpubValidationError = validateExtendedPublicKey(
        typeof xpub === "string" ? xpub : xpub.base58String,
        this.network
      );
      assert(!xpubValidationError.length, xpubValidationError);
    });
    this.extendedPublicKeys = options.extendedPublicKeys;

    assert(typeof options.requiredSigners === "number");
    assert(
      options.requiredSigners <= this.extendedPublicKeys.length,
      `Can't have more requiredSigners than there are keys.`
    );
    this.requiredSigners = options.requiredSigners;

    // index is a technically a bip32path, but it's also just an
    // unhardened index (single number) - if we think of the bip32path as a
    // filepath, then this is a directory that historically/typically tells you
    // deposit (0) or change (1) braid, but could be any unhardened index.
    const pathError = validateBIP32Index(options.index, { mode: "unhardened" });
    assert(!pathError.length, pathError);
    this.index = options.index;
    this.sequence = bip32PathToSequence(this.index);
  }

  toJSON() {
    return braidConfig(this);
  }

  static fromData(data) {
    return new this(data);
  }

  static fromJSON(string) {
    return new this(JSON.parse(string));
  }
}

/**
 * @param {Braid} braid A Braid struct to be 'exported'
 * @returns {string} string of JSON data which can used to reconstitute the Braid later
 */
export function braidConfig(braid) {
  return JSON.stringify({
    network: braid.network,
    addressType: braid.addressType,
    extendedPublicKeys: braid.extendedPublicKeys,
    requiredSigners: braid.requiredSigners,
    index: braid.index,
  });
}

/**
 * Returns the braid's network
 * @param {Braid} braid the braid to interrogate
 * @returns {string} network string testnet/mainnet
 */
export function braidNetwork(braid) {
  return braid.network;
}

/**
 * Returns the braid's addressType
 * @param {Braid} braid the braid to interrogate
 * @returns {string} address type p2sh/p2sh-p2wsh/p2wsh
 */
export function braidAddressType(braid) {
  return braid.addressType;
}

/**
 * Returns the braid's extendedPublicKeys
 * @param {Braid} braid the braid to interrogate
 * @returns {ExtendedPublicKey[]} array of ExtendedPublicKeys in the braid
 */
export function braidExtendedPublicKeys(braid) {
  return braid.extendedPublicKeys;
}

/**
 * Returns the braid's requiredSigners
 * @param {Braid} braid the braid to interrogate
 * @returns {number} number of required signers
 */
export function braidRequiredSigners(braid) {
  return braid.requiredSigners;
}

/**
 * Returns the braid's index
 * @param {Braid} braid the braid to interrogate
 * @returns {string} index (singular) for the braid: 0 = deposit, 1 = change
 */
export function braidIndex(braid) {
  return braid.index;
}

/**
 * Validate that a requested path is derivable from a particular braid
 * e.g. it's both a valid bip32path *and* its first index is the same as the index
 *
 * @param {Braid} braid the braid to interrogate
 * @param {string} path the path to validate
 * @returns {void} the assertions will fire errors if invalid
 */
export function validateBip32PathForBraid(braid, path) {
  const pathError = validateBIP32Path(path);
  assert(!pathError.length, pathError);

  // The function bip32PathToSequence blindly slices the first index after splitting on '/',
  // so make sure the slash is there. E.g. a path of "0/0" would validate in the above function,
  // but fail to do what we expect here unless we prepend '/' as '/0/0'.
  const pathToCheck =
    path.startsWith("m/") || path.startsWith("/") ? path : "/" + path;
  const pathSequence = bip32PathToSequence(pathToCheck);
  assert(
    pathSequence[0].toString() === braid.index,
    `Cannot derive paths outside of the braid's index: ${braid.index}`
  );
}

/**
 * Returns an object with a braid's pubkeys + bip32derivation info
 * at a particular path (respects the index)
 *
 * @param {Braid} braid the braid to interrogate
 * @param {string} path what suffix to generate pubkeys at
 * @returns {Object} Object where the keys make up an array of public keys at a particular path and the values are the bip32Derivations (used in other places)
 */
function derivePublicKeyObjectsAtPath(braid, path) {
  validateBip32PathForBraid(braid, path);
  const dataRichPubKeyObjects = {};
  const actualPathSuffix = path.startsWith("m/") ? path.slice(2) : path;

  braidExtendedPublicKeys(braid).forEach((xpub) => {
    const completePath = xpub.path + "/" + actualPathSuffix;
    // Provide ability to work whether this was called with plain xpub strings or with xpub structs
    const pubkey = deriveChildPublicKey(
      typeof xpub === "string" ? xpub : xpub.base58String,
      path,
      braidNetwork(braid)
    );
    // It's ok if this is faked - but at least one of them should be correct otherwise
    // signing won't work. On Coldcard, this must match what was included in the multisig
    // wallet config file.
    const rootFingerprint = extendedPublicKeyRootFingerprint(xpub);
    const masterFingerprint = rootFingerprint
      ? rootFingerprint
      : FAKE_ROOT_FINGERPRINT;
    dataRichPubKeyObjects[pubkey] = {
      masterFingerprint: Buffer.from(masterFingerprint, "hex"),
      path: completePath,
      pubkey: Buffer.from(pubkey, "hex"),
    };
  });
  return dataRichPubKeyObjects;
}

/**
 * Returns the braid's pubkeys at particular path (respects the index)
 *
 * @param {Braid} braid the braid to interrogate
 * @param {string} path the suffix to generate pubkeys at
 * @returns {string[]} array of sorted (BIP67) public keys at a particular index from the braid
 */
export function generatePublicKeysAtPath(braid, path) {
  return Object.keys(derivePublicKeyObjectsAtPath(braid, path)).sort(); // BIP67
}

/**
 * Returns the braid's pubkeys at particular index under the index
 *
 * @param {Braid} braid the braid to interrogate
 * @param {number} index the suffix to generate pubkeys at
 * @returns {string[]} array of public keys at a particular index from the braid
 */
export function generatePublicKeysAtIndex(braid, index) {
  let pathToDerive = braidIndex(braid);
  pathToDerive += "/" + index.toString();
  return generatePublicKeysAtPath(braid, pathToDerive);
}

/**
 * Returns the braid's bip32PathDerivation (array of bip32 infos)
 * @param {Braid} braid the braid to interrogate
 * @param {string} path what suffix to generate bip32PathDerivation at
 * @returns {Object[]} array of getBip32Derivation objects
 */
export function generateBip32DerivationByPath(braid, path) {
  return Object.values(derivePublicKeyObjectsAtPath(braid, path));
}

/**
 * Returns the braid's bip32PathDerivation at a particular index (array of bip32 info)
 * @param {Braid} braid the braid to interrogate
 * @param {number} index what suffix to generate bip32PathDerivation at
 * @returns {Object[]} array of getBip32Derivation objects
 */
export function generateBip32DerivationByIndex(braid, index) {
  let pathToDerive = braidIndex(braid); // deposit or change
  pathToDerive += "/" + index.toString();
  return generateBip32DerivationByPath(braid, pathToDerive);
}

/**
 * Returns a braid-aware Multisig object at particular path (respects index)
 * @param {Braid} braid the braid to interrogate
 * @param {string} path what suffix to generate the multisig at
 * @returns {module:multisig.Multisig} braid-aware MULTISIG object at path
 */
export function deriveMultisigByPath(braid, path) {
  const pubkeys = generatePublicKeysAtPath(braid, path);
  const bip32Derivation = generateBip32DerivationByPath(braid, path);
  return generateBraidAwareMultisigFromPublicKeys(
    braid,
    pubkeys,
    bip32Derivation
  );
}

/**
 * Returns a braid-aware Multisig object at particular index
 * @param {Braid} braid the braid to interrogate
 * @param {number} index what suffix to generate the multisig at
 * @returns {module:multisig.Multisig} braid-aware MULTISIG object at index
 */
export function deriveMultisigByIndex(braid, index) {
  let pathToDerive = braidIndex(braid);
  pathToDerive += "/" + index.toString();
  return deriveMultisigByPath(braid, pathToDerive);
}

/**
 * Returns a braid-aware Multisig object from a set of public keys
 *
 * @param {Braid} braid the braid to interrogate
 * @param {string[]} pubkeys what suffix to generate the multisig at
 * @param {Object[]} bip32Derivation this is the array of bip32info for each member of the multisig
 * @returns {module:multisig.Multisig} braid-aware MULTISIG object
 */
function generateBraidAwareMultisigFromPublicKeys(
  braid,
  pubkeys,
  bip32Derivation
) {
  const multisig = generateMultisigFromPublicKeys(
    braidNetwork(braid),
    braidAddressType(braid),
    braidRequiredSigners(braid),
    ...pubkeys
  );
  multisig.braidDetails = braidConfig(braid);
  multisig.bip32Derivation = bip32Derivation;
  return multisig;
}

/**
 * Generate a braid from its parts
 *
 * @param {string} network - mainnet or testnet
 * @param {string} addressType - P2SH/P2SH-P2WSH/P2WSH
 * @param {module:keys.ExtendedPublicKey[]} extendedPublicKeys - array of xpubs that make up the braid
 * @param {number} requiredSigners - number signers needed to sign
 * @param {string} index (usually deposit/change) - e.g. '0' or '1'
 * @returns {Braid} Braid struct is returned
 */
export function generateBraid(
  network,
  addressType,
  extendedPublicKeys,
  requiredSigners,
  index
) {
  return new Braid({
    network,
    addressType,
    extendedPublicKeys,
    requiredSigners,
    index,
  });
}
