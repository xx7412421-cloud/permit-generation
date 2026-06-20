import { BigNumber, Contract, ethers, utils } from "ethers";
import { Erc20TransferReward, TokenType } from "../types";
import { Context, Logger } from "../types/context";
import { decrypt, parseDecryptedPrivateKey } from "../utils";
import { getRpcProvider } from "../utils/get-fastest-provider";

const ERC20_TRANSFER_ABI = ["function decimals() public view returns (uint8)", "function transfer(address to, uint256 amount) public returns (bool)"];
const BASIS_POINTS = 10000;
const DEFAULT_GAS_BUFFER_BPS = 2000;

interface TransferPayload {
  evmNetworkId: number;
  evmPrivateEncrypted: string;
  walletAddress: string;
  logger: Logger;
  userId: number;
  feeRecipient?: string;
  feeBps?: string;
}

export function splitTransferAmount(amount: BigNumber | string, feeBps: number) {
  if (feeBps < 0 || feeBps > BASIS_POINTS) {
    throw new Error("Operator fee bps must be between 0 and 10000");
  }

  const grossAmount = BigNumber.from(amount);
  const operatorFeeAmount = grossAmount.mul(feeBps).div(BASIS_POINTS);
  const beneficiaryAmount = grossAmount.sub(operatorFeeAmount);

  return {
    beneficiaryAmount: beneficiaryAmount.toString(),
    operatorFeeAmount: operatorFeeAmount.toString(),
  };
}

export function addGasBuffer(gasEstimate: BigNumber | string, bufferBps = DEFAULT_GAS_BUFFER_BPS) {
  if (bufferBps < 0) {
    throw new Error("Gas buffer bps must not be negative");
  }

  const gas = BigNumber.from(gasEstimate);
  return gas.add(gas.mul(bufferBps).div(BASIS_POINTS));
}

export async function generateErc20Transfer(payload: TransferPayload, username: string, amount: number, tokenAddress: string): Promise<Erc20TransferReward>;
export async function generateErc20Transfer(context: Context, username: string, amount: number, tokenAddress: string): Promise<Erc20TransferReward>;
export async function generateErc20Transfer(
  contextOrPayload: Context | TransferPayload,
  username: string,
  amount: number,
  tokenAddress: string
): Promise<Erc20TransferReward> {
  let logger: Logger;
  let walletAddress: string | null | undefined;
  let evmNetworkId: number;
  let evmPrivateEncrypted: string;
  let feeRecipient: string | undefined;
  let feeBps: string | undefined;

  if ("walletAddress" in contextOrPayload) {
    logger = contextOrPayload.logger;
    walletAddress = contextOrPayload.walletAddress;
    evmNetworkId = contextOrPayload.evmNetworkId;
    evmPrivateEncrypted = contextOrPayload.evmPrivateEncrypted;
    feeRecipient = contextOrPayload.feeRecipient;
    feeBps = contextOrPayload.feeBps;
  } else {
    logger = contextOrPayload.logger;
    evmNetworkId = contextOrPayload.config.evmNetworkId;
    evmPrivateEncrypted = contextOrPayload.config.evmPrivateEncrypted;
    feeRecipient = contextOrPayload.env.UBIQUITY_FEE_RECIPIENT;
    feeBps = contextOrPayload.env.UBIQUITY_FEE_BPS;

    const { data: userData } = await contextOrPayload.octokit.rest.users.getByUsername({ username });
    if (!userData) {
      throw new Error(`GitHub user was not found for id ${username}`);
    }

    walletAddress = await contextOrPayload.adapters.supabase.wallet.getWalletByUserId(userData.id);
  }

  if (!username) {
    throw new Error("User was not found");
  }
  if (!walletAddress) {
    const errorMessage = "ERC20 transfer error: Wallet not found";
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  const provider = await getRpcProvider(evmNetworkId);
  if (!provider) {
    logger.error("Provider is not defined");
    throw new Error("Provider is not defined");
  }

  const privateKey = await getPrivateKey(evmPrivateEncrypted, logger);
  const adminWallet = await getAdminWallet(privateKey, provider, logger);
  const tokenContract = new Contract(tokenAddress, ERC20_TRANSFER_ABI, adminWallet);
  const tokenDecimals = await getTokenDecimals(tokenContract, tokenAddress, logger);
  const grossAmount = utils.parseUnits(amount.toString(), tokenDecimals);
  const feeBasisPoints = parseFeeBps(feeBps);
  const { beneficiaryAmount, operatorFeeAmount } = splitTransferAmount(grossAmount, feeBasisPoints);

  const beneficiaryTransfer = await sendTokenTransfer(tokenContract, walletAddress, beneficiaryAmount);
  const feeTransfers = [];

  if (!BigNumber.from(operatorFeeAmount).isZero()) {
    if (!feeRecipient) {
      throw new Error("UBIQUITY_FEE_RECIPIENT must be configured when UBIQUITY_FEE_BPS is greater than zero");
    }
    const resolvedFeeRecipient = await resolveTransferAddress(provider, feeRecipient);
    const feeTransfer = await sendTokenTransfer(tokenContract, resolvedFeeRecipient, operatorFeeAmount);
    feeTransfers.push({
      beneficiary: resolvedFeeRecipient,
      amount: operatorFeeAmount,
      transactionHash: feeTransfer.transactionHash,
      gasEstimate: feeTransfer.gasEstimate,
    });
  }

  const transferReward: Erc20TransferReward = {
    type: "erc20-transfer",
    tokenType: TokenType.ERC20,
    tokenAddress,
    beneficiary: walletAddress,
    amount: beneficiaryAmount,
    owner: adminWallet.address,
    networkId: evmNetworkId,
    transactionHash: beneficiaryTransfer.transactionHash,
    gasEstimate: beneficiaryTransfer.gasEstimate,
    feeTransfers,
  };

  logger.info("Transferred ERC20 reward", transferReward);

  return transferReward;
}

function parseFeeBps(feeBps?: string) {
  if (!feeBps) {
    return 0;
  }

  const parsed = Number.parseInt(feeBps, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > BASIS_POINTS) {
    throw new Error("UBIQUITY_FEE_BPS must be an integer between 0 and 10000");
  }

  return parsed;
}

async function getPrivateKey(evmPrivateEncrypted: string, logger: Logger) {
  try {
    const privateKeyDecrypted = await decrypt(evmPrivateEncrypted, String(process.env.X25519_PRIVATE_KEY));
    const privateKeyParsed = parseDecryptedPrivateKey(privateKeyDecrypted);
    const privateKey = privateKeyParsed.privateKey;
    if (!privateKey) throw new Error("Private key is not defined");
    return privateKey;
  } catch (error) {
    const errorMessage = `Failed to decrypt a private key: ${error}`;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }
}

async function getAdminWallet(privateKey: string, provider: ethers.providers.Provider, logger: Logger) {
  try {
    return new ethers.Wallet(privateKey, provider);
  } catch (error) {
    const errorMessage = `Failed to instantiate wallet: ${error}`;
    logger.debug(errorMessage);
    throw new Error(errorMessage);
  }
}

async function getTokenDecimals(tokenContract: Contract, tokenAddress: string, logger: Logger) {
  try {
    return await tokenContract.decimals();
  } catch (error) {
    const errorMessage = `Failed to get token decimals for token: ${tokenAddress}, ${error}`;
    logger.debug(errorMessage, { error });
    throw new Error(errorMessage);
  }
}

async function sendTokenTransfer(tokenContract: Contract, beneficiary: string, amount: string) {
  const gasEstimate = await tokenContract.estimateGas.transfer(beneficiary, amount);
  const gasLimit = addGasBuffer(gasEstimate);
  const transaction = await tokenContract.transfer(beneficiary, amount, { gasLimit });

  return {
    transactionHash: transaction.hash,
    gasEstimate: gasEstimate.toString(),
  };
}

async function resolveTransferAddress(provider: ethers.providers.Provider, beneficiary: string) {
  if (utils.isAddress(beneficiary)) {
    return beneficiary;
  }

  const resolvedAddress = await provider.resolveName(beneficiary);
  if (!resolvedAddress) {
    throw new Error(`Unable to resolve transfer beneficiary: ${beneficiary}`);
  }

  return resolvedAddress;
}
