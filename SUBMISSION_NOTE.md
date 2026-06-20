Resolves #6

## Summary

- Adds an optional `transfer: true` setting that routes ERC20 payout requests through a direct token transfer path instead of permit signature generation.
- Adds `generateErc20Transfer`, which resolves the beneficiary wallet from the request username, decrypts the configured admin wallet, reads token decimals, estimates transfer gas, applies a 20% gas buffer, and sends the ERC20 transfer.
- Adds operator fee support through worker-level environment settings: `UBIQUITY_FEE_BPS` and `UBIQUITY_FEE_RECIPIENT`.
- Keeps existing ERC20 permit and ERC721 permit behavior unchanged when `transfer` is not enabled.

## Safety And Edge Cases

- The handler fails closed if token decimals cannot be read instead of assuming 18 decimals.
- Fee basis points must be between 0 and 10000.
- A fee recipient is required when a non-zero fee is configured, avoiding hidden ENS assumptions on non-ENS networks.
- The beneficiary transfer is sent before the optional fee transfer, so a fee cannot be collected if the beneficiary payout fails.

## Verification

- `bun x jest tests/generate-payout-permit.test.ts --runInBand`
- `bun x jest --runInBand`
- `bun run build`
- `bun x prettier --check src/types/plugin-input.ts src/types/env.ts src/types/permits.ts src/handlers/generate-payout-permit.ts src/handlers/index.ts src/handlers/generate-erc20-transfer.ts tests/generate-payout-permit.test.ts`
- `bun x eslint src/types/plugin-input.ts src/types/env.ts src/types/permits.ts src/handlers/generate-payout-permit.ts src/handlers/index.ts src/handlers/generate-erc20-transfer.ts tests/generate-payout-permit.test.ts`
- `bun x cspell src/types/plugin-input.ts src/types/env.ts src/types/permits.ts src/handlers/generate-payout-permit.ts src/handlers/index.ts src/handlers/generate-erc20-transfer.ts tests/generate-payout-permit.test.ts`
