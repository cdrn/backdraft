import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });
const code = await client.getCode({ address: "0x2BB625DAa0A9dD2C69939cBD6c2dBae2ac6667AC" });
const bytes = Buffer.from(code.slice(2), "hex");
const hex = code.slice(2);

const OP = {
  0x00: "STOP", 0x01: "ADD", 0x02: "MUL", 0x03: "SUB", 0x04: "DIV", 0x06: "MOD", 0x10: "LT", 0x11: "GT", 0x14: "EQ", 0x15: "ISZERO", 0x16: "AND", 0x17: "OR", 0x18: "XOR", 0x19: "NOT", 0x1a: "BYTE", 0x1b: "SHL", 0x1c: "SHR", 0x1d: "SAR", 0x20: "KECCAK256",
  0x30: "ADDRESS", 0x31: "BALANCE", 0x32: "ORIGIN", 0x33: "CALLER", 0x34: "CALLVALUE", 0x35: "CALLDATALOAD", 0x36: "CALLDATASIZE", 0x37: "CALLDATACOPY", 0x39: "CODECOPY", 0x3b: "EXTCODESIZE", 0x3d: "RETURNDATASIZE",
  0x42: "TIMESTAMP", 0x43: "NUMBER", 0x46: "CHAINID", 0x47: "SELFBALANCE", 0x50: "POP", 0x51: "MLOAD", 0x52: "MSTORE", 0x53: "MSTORE8", 0x54: "SLOAD", 0x55: "SSTORE", 0x56: "JUMP", 0x57: "JUMPI", 0x58: "PC", 0x59: "MSIZE", 0x5a: "GAS", 0x5b: "JUMPDEST", 0x5f: "PUSH0",
  0xf0: "CREATE", 0xf1: "CALL", 0xf3: "RETURN", 0xf4: "DELEGATECALL", 0xfa: "STATICCALL", 0xfd: "REVERT", 0xfe: "INVALID",
};
function opName(b) {
  if (OP[b]) return OP[b];
  if (b >= 0x60 && b <= 0x7f) return `PUSH${b - 0x5f}`;
  if (b >= 0x80 && b <= 0x8f) return `DUP${b - 0x7f}`;
  if (b >= 0x90 && b <= 0x9f) return `SWAP${b - 0x8f}`;
  if (b >= 0xa0 && b <= 0xa4) return `LOG${b - 0xa0}`;
  return `0x${b.toString(16)}`;
}
function disasm(fromPc, len) {
  const out = [];
  let pc = fromPc;
  const end = Math.min(bytes.length, fromPc + len);
  while (pc < end) {
    const b = bytes[pc];
    const name = opName(b);
    if (b >= 0x60 && b <= 0x7f) {
      const n = b - 0x5f;
      out.push([pc, name, "0x" + bytes.slice(pc + 1, pc + 1 + n).toString("hex")]);
      pc += 1 + n;
    } else {
      out.push([pc, name, ""]);
      pc += 1;
    }
  }
  return out;
}

// transferFrom selector: 0x23b872dd
const idx = hex.indexOf("6323b872dd14");
const dispatchPc = idx / 2;
console.log(`Dispatch for transferFrom at PC ${dispatchPc}`);

// Find the jump target after this
const tIdx = hex.indexOf("61", idx);
const targetPc = parseInt(hex.slice(tIdx + 2, tIdx + 6), 16);
console.log(`Body starts at PC ${targetPc}\n`);

console.log("=== TRANSFERFROM FUNCTION BODY ===");
for (const [pc, name, arg] of disasm(targetPc, 900)) {
  let hl = "";
  if (name === "CALLER") hl = "    <- msg.sender";
  if (name === "ORIGIN") hl = "    <- tx.origin";
  if (name === "EQ") hl = "    <- ==";
  if (name === "REVERT") hl = "    <- !!! REVERT !!!";
  if (name === "SLOAD") hl = "    <- storage read";
  if (name === "KECCAK256") hl = "    <- hash";
  console.log(`  ${pc.toString().padStart(5)} ${name.padEnd(12)} ${arg.padEnd(20)}${hl}`);
}
