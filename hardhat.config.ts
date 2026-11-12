import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config();

const SOLC_VERSION = "0.8.24";

// Use the solcjs (wasm) build shipped in node_modules so compiling works
// offline / behind proxies that block binaries.soliditylang.org.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: any, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const compilerPath = path.join(__dirname, "node_modules", "solc", "soljson.js");
    return { compilerPath, isSolcJs: true, version: args.solcVersion, longVersion: SOLC_VERSION };
  }
  return runSuper();
});

const FUJI_RPC = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const DEPLOYER = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    fuji: {
      url: FUJI_RPC,
      chainId: 43113,
      accounts: DEPLOYER ? [DEPLOYER] : [],
    },
  },
  mocha: { timeout: 60000 },
};

export default config;
