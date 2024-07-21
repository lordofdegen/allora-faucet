import express from 'express';

import { Wallet } from '@ethersproject/wallet'
import { pathToString } from '@cosmjs/crypto';

import { BigNumber, ethers } from 'ethers'
import { bech32 } from 'bech32';

import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";

import conf from './config/config.js'
import { FrequencyChecker } from './checker.js';

// load config
console.log("loaded config: ", conf)

const app = express()

app.set("view engine", "ejs");

const checker = new FrequencyChecker(conf)

app.use((req, res, next) => {
  const clientip = req.headers['x-real-ip'] || req.headers['X-Real-IP'] || req.headers['X-Forwarded-For'] || req.ip
  console.log(`Received ${req.method} request at ${req.url} from ${clientip}`);
  next();
});

app.get('/', (req, res) => {
  res.render('index', conf);
})

app.get('/config.json', async (req, res) => {
  const sample = {}
  for(let i =0; i < conf.blockchains.length; i++) {
    const chainConf = conf.blockchains[i]
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(chainConf.sender.mnemonic, chainConf.sender.option);
    const [firstAccount] = await wallet.getAccounts();
    sample[chainConf.name] = firstAccount.address

    const wallet2 = Wallet.fromMnemonic(chainConf.sender.mnemonic, pathToString(chainConf.sender.option.hdPaths[0]));
    console.log('address:', firstAccount.address, wallet2.address)
  }

  const project = conf.project
  project.sample = sample
  project.blockchains = conf.blockchains.map(x => x.name)
  project.addressPrefix = conf.blockchains[0].sender.option.prefix
  res.send(project);
})

const queue = [];
const addressStatus = {};

// Enqueue address
const enqueueAddress = async (statusAddress) => {
  console.log('Enqueueing address:', statusAddress);
  if (!addressStatus[statusAddress] || addressStatus[statusAddress] === 'cleared') {
    if (!queue.includes(statusAddress)) {
      queue.push(statusAddress);
    }
  }
};

// Process addresses
const processAddresses = async (chain) => {
  console.log('Starting to process addresses');
  while (true) {
    console.log(`the lenght of the queue: ${queue.length}`);
    if (queue.length > 0) {
      const statusAddress = queue.shift();
      const address = statusAddress.replace('status:', '');
      try {
        await sendTx(address, chain);
      } catch (error) {
        console.log(error, 'error')
      }
      addressStatus[statusAddress] = 'Completed';
      await checker.put(statusAddress, 'Completed');
    }

    console.log('Waiting for 5 seconds cooldown period');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
};

processAddresses(conf.blockchains[0].name);

app.get('/balance/:chain', async (req, res) => {
  const { chain }= req.params

  let balance = {}

  try{
    const chainConf = conf.blockchains.find(x => x.name === chain)
    if(chainConf) {
      if(chainConf.type === 'Ethermint') {
        const ethProvider = new ethers.providers.JsonRpcProvider(chainConf.endpoint.evm_endpoint);
        const wallet = Wallet.fromMnemonic(chainConf.sender.mnemonic, pathToString(chainConf.sender.option.hdPaths[0])).connect(ethProvider);
        await wallet.getBalance().then(ethBlance => {
          balance = {
            denom:chainConf.tx.amount.denom,
            amount:ethBlance.toString()
          }
        }).catch(e => console.error(e))

      }else{
        const rpcEndpoint = chainConf.endpoint.rpc_endpoint;
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(chainConf.sender.mnemonic, chainConf.sender.option);
        const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet);
        const [firstAccount] = await wallet.getAccounts();
        await client.getBalance(firstAccount.address, chainConf.tx.amount[0].denom).then(x => {
          balance = x
        }).catch(e => console.error(e));
      }
    }
  } catch(err) {
    console.log(err)
  }
  res.send(balance);
})

app.get('/status/:address', async (req, res, next) => {
  return Promise.resolve().then(async () => {
    const { address } = req.params;
    const statusAddress = `status:${address}`;

    let status = await checker.get(statusAddress);
    if (!status) {
      status = queue.includes("pending") && 'not found';
    }
    res.json({ code: 0, status });

    if (status === 'Completed') {
      addressStatus[statusAddress] = 'cleared';
      await checker.put(statusAddress, 'cleared');
    }
  }).catch(next)
});

app.get('/send/:chain/:address', async (req, res, next) => {
  return Promise.resolve().then(async () => {

    const {chain, address} = req.params;
    const ip = req.headers['x-real-ip'] || req.headers['X-Real-IP'] || req.headers['X-Forwarded-For'] || req.ip
    console.log('request tokens to ', address, ip)
    if (chain || address ) {
      // try {
        const chainConf = conf.blockchains.find(x => x.name === chain)
        if (chainConf && (address.startsWith(chainConf.sender.option.prefix) || address.startsWith('0x'))) {
          if( await checker.checkAddress(address, chain) && await checker.checkIp(`${chain}${ip}`, chain) ) {
            checker.update(`${chain}${ip}`) // get ::1 on localhost

            const statusAddress = `status:${address}`
            if (addressStatus[statusAddress] === 'Completed') {
              console.log('Address has already received faucet');
              return res.status(400).json({ code: 1, message: 'Address has already received faucet' });
            }

            await enqueueAddress(statusAddress);
            res.json({ code: 0, message: 'Address enqueued for faucet processing.' });

            await checker.update(address)

          }else {
            res.send({ code: 1, message: `Too many faucet requests sent for address '${address}'. Try again later.
              \nLimits per 24h: ${chainConf.limit.address} times per address, ${chainConf.limit.ip} times per IP.
            `})
          }
        } else {
          res.send({ code: 1, message: `Address '${address}' is not supported.`, recipient: address })
        }
      // } catch (err) {
      //   console.error(err);
      //   res.send({ result: 'Failed, Please contact to admin.' })
      // }

    } else {
      // send result
      res.send({ code: 0, message: 'address is required' });
    }}).catch(next)
})

// 500 - Any server error
app.use((err, req, res) => {
  console.log("\nError catched by error middleware:", err.stack)
})

app.listen(conf.port, () => {
  console.log(`Faucet app listening on port ${conf.port}`)
})

async function sendCosmosTx(recipient, chain) {
  console.log("sendCosmosTx", recipient, chain)
  // const mnemonic = "surround miss nominee dream gap cross assault thank captain prosper drop duty group candy wealth weather scale put";
  const chainConf = conf.blockchains.find(x => x.name === chain) 
  if(chainConf) {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(chainConf.sender.mnemonic, chainConf.sender.option);
    const [firstAccount] = await wallet.getAccounts();

    // console.log("sender", firstAccount);
    const rpcEndpoint = chainConf.endpoint.rpc_endpoint;
    const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet);
    // const recipient = "cosmos1xv9tklw7d82sezh9haa573wufgy59vmwe6xxe5";
    const amount = chainConf.tx.amount;
    const fee = chainConf.tx.fee;
    const initialAccountBalance = await client.getBalance(recipient, chainConf.tx.amount[0].denom)
    try {
      return await client.sendTokens(firstAccount.address, recipient, amount, fee);
    } catch(e) {
      const finalAccountBalance = await client.getBalance(recipient, chainConf.tx.amount[0].denom)
      const diff = BigNumber.from(finalAccountBalance.amount).sub(BigNumber.from(initialAccountBalance.amount))
      if (!diff.eq(BigNumber.from(amount[0].amount))) {
        throw new Error(`Recipient balance did not increase by the expected amount. Error: ${e.message}`)
      }
    }
    console.log(`Sent ${amount} tokens to ${recipient}`)
    return {code: 0}
  }
  throw new Error(`Blockchain Config [${chain}] not found`)
}

async function sendEvmosTx(recipient, chain) {

  try{
    const chainConf = conf.blockchains.find(x => x.name === chain)
    const ethProvider = new ethers.providers.JsonRpcProvider(chainConf.endpoint.evm_endpoint);

    const wallet = Wallet.fromMnemonic(chainConf.sender.mnemonic).connect(ethProvider);

    let evmAddress =  recipient;
    if(recipient && !recipient.startsWith('0x')) {
      let decode = bech32.decode(recipient);
      let array = bech32.fromWords(decode.words);
      evmAddress =  "0x" + toHexString(array);
    }

    let result = await wallet.sendTransaction(
        {
          from:wallet.address,
          to:evmAddress,
          value:chainConf.tx.amount.amount
        }
      );

    let repTx = {
      "code":0,
      "nonce":result["nonce"],
      "value":result["value"].toString(),
      "hash":result["hash"]
    };

    console.log("xxl result : ",repTx);
    return repTx;
  }catch(e){
    console.log("xxl e ",e);
    return e;
  }

}

function toHexString(bytes) {
  return bytes.reduce(
      (str, byte) => str + byte.toString(16).padStart(2, '0'),
      '');
}

async function sendTx(recipient, chain) {
  const chainConf = conf.blockchains.find(x => x.name === chain)
  if(chainConf.type === 'Ethermint') {
    return sendEvmosTx(recipient, chain)
  }
  return sendCosmosTx(recipient, chain)
}

// write a function to send evmos transaction
async function sendEvmosTx2(recipient, chain) {

  // use evmosjs to send transaction
  const chainConf = conf.blockchains.find(x => x.name === chain)
  // create a wallet instance
  const wallet = Wallet.fromMnemonic(chainConf.sender.mnemonic).connect(chainConf.endpoint.evm_endpoint);
}
