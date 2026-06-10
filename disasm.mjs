import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const code = await client.getCode({ address: "0x2BB625DAa0A9dD2C69939cBD6c2dBae2ac6667AC" });
const bytes = Buffer.from(code.slice(2), "hex");

// Minimal EVM opcode names (just enough)
const OP = {
  0x00: "STOP", 0x01: "ADD", 0x02: "MUL", 0x03: "SUB", 0x04: "DIV", 0x05: "SDIV", 0x06: "MOD",
  0x10: "LT", 0x11: "GT", 0x12: "SLT", 0x13: "SGT", 0x14: "EQ", 0x15: "ISZERO", 0x16: "AND", 0x17: "OR", 0x18: "XOR", 0x19: "NOT", 0x1a: "BYTE", 0x1b: "SHL", 0x1c: "SHR", 0x1d: "SAR",
  0x20: "KECCAK256",
  0x30: "ADDRESS", 0x31: "BALANCE", 0x32: "ORIGIN", 0x33: "CALLER", 0x34: "CALLVALUE", 0x35: "CALLDATALOAD", 0x36: "CALLDATASIZE", 0x37: "CALLDATACOPY", 0x38: "CODESIZE", 0x39: "CODECOPY", 0x3a: "GASPRICE", 0x3b: "EXTCODESIZE", 0x3c: "EXTCODECOPY", 0x3d: "RETURNDATASIZE", 0x3e: "RETURNDATACOPY", 0x3f: "EXTCODEHASH",
  0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER", 0x44: "PREVRANDAO", 0x45: "GASLIMIT", 0x46: "CHAINID", 0x47: "SELFBALANCE", 0x48: "BASEFEE", 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE",
  0x50: "POP", 0x51: "MLOAD", 0x52: "MSTORE", 0x53: "MSTORE8", 0x54: "SLOAD", 0x55: "SSTORE", 0x56: "JUMP", 0x57: "JUMPI", 0x58: "PC", 0x59: "MSIZE", 0x5a: "GAS", 0x5b: "JUMPDEST", 0x5c: "TLOAD", 0x5d: "TSTORE", 0x5e: "MCOPY", 0x5f: "PUSH0",
  0xf0: "CREATE", 0xf1: "CALL", 0xf2: "CALLCODE", 0xf3: "RETURN", 0xf4: "DELEGATECALL", 0xf5: "CREATE2", 0xfa: "STATICCALL", 0xfd: "REVERT", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
};
function opName(b, pc) {
  if (OP[b]) return OP[b];
  if (b >= 0x60 && b <= 0x7f) return `PUSH${b - 0x5f}`;
  if (b >= 0x80 && b <= 0x8f) return `DUP${b - 0x7f}`;
  if (b >= 0x90 && b <= 0x9f) return `SWAP${b - 0x8f}`;
  if (b >= 0xa0 && b <= 0xa4) return `LOG${b - 0xa0}`;
  return `0x${b.toString(16)}`;
}

// Walk bytecode and produce disassembly
function disasm(bytes, fromPc = 0, length = bytes.length) {
  const out = [];
  let pc = fromPc;
  const end = Math.min(bytes.length, fromPc + length);
  while (pc < end) {
    const b = bytes[pc];
    const name = opName(b, pc);
    let arg = "";
    if (b >= 0x60 && b <= 0x7f) {
      const n = b - 0x5f;
      const val = bytes.slice(pc + 1, pc + 1 + n).toString("hex");
      arg = "0x" + val;
      out.push([pc, name, arg]);
      pc += 1 + n;
    } else {
      out.push([pc, name, arg]);
      pc += 1;
    }
  }
  return out;
}

// Find the transfer selector in dispatch: pattern PUSH4 a9059cbb EQ
const TRANSFER_SEL = "a9059cbb";
const hex = code.slice(2);
const dispatchIdx = hex.indexOf("63" + TRANSFER_SEL + "14");
if (dispatchIdx < 0) { console.log("transfer selector not found"); process.exit(1); }
const dispatchPc = dispatchIdx / 2;
console.log(`Dispatch for transfer at PC ${dispatchPc}`);

// Disassemble forward from the dispatch entry until we see the JUMPI to the function body
const lines = disasm(bytes, dispatchPc, 40);
for (const [pc, name, arg] of lines) {
  console.log(`  ${pc.toString().padStart(5)} ${name.padEnd(10)} ${arg}`);
}

// Find the jump dest (the next PUSH2 after EQ)
const targetIdx = hex.indexOf("61", dispatchIdx);  // PUSH2
const targetPc = parseInt(hex.slice(targetIdx + 2, targetIdx + 6), 16);
console.log(`\nJump target for transfer body: PC ${targetPc}\n`);

// Disassemble the function body — first ~200 opcodes
console.log("=== TRANSFER FUNCTION BODY ===");
const body = disasm(bytes, targetPc, 600);
for (const [pc, name, arg] of body) {
  let highlight = "";
  if (name === "CALLER") highlight = "  // <- msg.sender";
  if (name === "ORIGIN") highlight = "  // <- tx.origin";
  if (name === "SLOAD") highlight = "  // <- storage read";
  if (name === "REVERT") highlight = "  // <- !!! REVERT !!!";
  if (name === "EQ") highlight = "  // <- equality check";
  console.log(`  ${pc.toString().padStart(5)} ${name.padEnd(10)} ${arg}${highlight}`);
}
