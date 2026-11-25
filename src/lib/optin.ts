// Per-round opt-in: the signed message and signature recovery. Opt-ins are stored in the
// opt_ins table (see rounds.ts).
//
// A wallet opts in by signing (personal_sign, free, no transaction) a message that names
// the round id. The server rebuilds the exact message, recovers the signer and records
// it. Because the round id is inside the signed text, an opt-in can never be replayed
// for another round: every round needs a fresh opt-in.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { OPT_IN_TERMS } from "./config.ts";

export interface RoundInfo {
  id: string;
  name: string;
  start: number;
  end: number;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function optInMessage(round: RoundInfo, wallet: string, issuedAt: number): string {
  return [
    "Katana Spot Trading Competition",
    "",
    `I'm joining ${round.name} (${fmt(round.start)} to ${fmt(round.end)}) with this wallet.`,
    "Only my trades from now until the round ends will count.",
    `I agree to the competition terms (${OPT_IN_TERMS}).`,
    "",
    "This signature is free and does not send a transaction.",
    "",
    `Wallet: ${wallet}`,
    `Round: ${round.id}`,
    `Issued: ${new Date(issuedAt * 1000).toISOString()}`,
  ].join("\n");
}

// EIP-191 personal_sign recovery. Returns the lowercase signer address, or null if the
// signature is malformed.
export function recoverSigner(message: string, signatureHex: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) return null;
  try {
    const sig = hexToBytes(signatureHex.slice(2));
    const body = utf8ToBytes(message);
    const hash = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), ...body]));
    const v = sig[64]!;
    const recovery = v >= 27 ? v - 27 : v;
    if (recovery !== 0 && recovery !== 1) return null;
    const pub = secp256k1.recoverPublicKey(new Uint8Array([recovery, ...sig.slice(0, 64)]), hash, { prehash: false });
    const full = secp256k1.Point.fromBytes(pub).toBytes(false);
    return "0x" + bytesToHex(keccak_256(full.slice(1)).slice(-20));
  } catch {
    return null;
  }
}

export function isAddress(s: unknown): s is string {
  return typeof s === "string" && ADDRESS.test(s);
}
