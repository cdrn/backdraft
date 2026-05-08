import type { Detector, DetectorContext } from "./types.js";

// Function selectors for withdrawal-type functions
const WITHDRAWAL_SELECTORS: Record<string, string> = {
  "3ccfd60b": "withdraw()",
  "2e1a7d4d": "withdraw(uint256)",
  "f3fef3a3": "withdraw(address,uint256)",
  "51cff8d9": "withdrawEther(address)",
  "f714ce06": "withdrawTo(uint256,address)",
  "6cb76d96": "sweep(address)",
  "01681a62": "sweep(address)", // alt
  "89476069": "withdrawToken(address)",
  "9e281a98": "withdrawToken(address,uint256)",
  "db2e21bc": "emergencyWithdraw()",
  "5312ea8e": "emergencyWithdraw(uint256)",
  "a9059cbb": "transfer(address,uint256)", // ERC20 — only interesting on the contract itself
  "853828b6": "drain()",
  "f940e385": "drain(address)",
  "e9fad8ee": "exit()",
  "7c4d82e5": "claimAll()",
  "4e71d92d": "claim()",
};

export const openWithdrawalDetector: Detector = {
  name: "open-withdrawal",
  description: "Detects contracts with unprotected withdrawal/sweep/drain functions",

  async detect(ctx: DetectorContext) {
    const { contract, client } = ctx;
    const code = contract.bytecode.slice(2);

    // First check if any withdrawal selectors exist in the bytecode
    const candidates: { selector: string; signature: string }[] = [];
    for (const [selector, signature] of Object.entries(WITHDRAWAL_SELECTORS)) {
      if (code.includes(selector)) {
        candidates.push({ selector, signature });
      }
    }

    if (candidates.length === 0) return;

    // Check if the contract holds any ETH
    const balance = await client.getBalance({ address: contract.address });

    // Try calling each withdrawal function via simulation
    for (const { selector, signature } of candidates) {
      // Build calldata with zero-padded args
      const argCount = (signature.match(/,/g) || []).length + (signature.endsWith("()") ? 0 : 1);
      const calldata = `0x${selector}${"0".repeat(64 * argCount)}` as `0x${string}`;

      try {
        await client.call({
          to: contract.address,
          data: calldata,
          account: contract.deployer, // simulate as deployer first
        });

        // Didn't revert when called as deployer — expected, but not interesting
        // Now try from a random address
        try {
          await client.call({
            to: contract.address,
            data: calldata,
            account: "0x0000000000000000000000000000000000000001",
          });

          // Didn't revert from a random address — this is open
          const hasValue = balance > 0n;
          ctx.findings.push({
            detector: "open-withdrawal",
            severity: hasValue ? "critical" : "high",
            title: `Unprotected ${signature}`,
            description: hasValue
              ? `${signature} callable by anyone. Contract holds ${balance} wei.`
              : `${signature} callable by anyone. Contract has no ETH (may hold tokens).`,
          });
          ctx.tags.add("open-withdrawal");
          ctx.meta.openWithdrawalFunctions ??= [];
          (ctx.meta.openWithdrawalFunctions as string[]).push(signature);

        } catch {
          // Reverted from random address — access controlled, fine
        }
      } catch {
        // Reverted even as deployer — function might need specific state
      }
    }
  },
};
