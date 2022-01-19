import { AbstractBot } from '../AbstractBot'
import { RegTestFoundationKeys, RegTest } from '@defichain/jellyfish-network'
import { EllipticPairProvider, P2WPKHTransactionBuilder, FeeRateProvider, Prevout, PrevoutProvider } from '@defichain/jellyfish-transaction-builder'
import BigNumber from 'bignumber.js'
import { Bech32, Elliptic, EllipticPair, HASH160, WIF } from '@defichain/jellyfish-crypto'
import { AppointOracle, OP_CODES, Script, CTransactionSegWit, TransactionSegWit, PoolCreatePair, SetLoanToken, SetCollateralToken } from '@defichain/jellyfish-transaction'
import { ApiClient } from '@defichain/jellyfish-api-core'
import { OraclePriceFeed } from '@defichain/jellyfish-api-core/src/category/oracle'
import { SmartBuffer } from 'smart-buffer'
import { P2WPKH } from '@defichain/jellyfish-address'

enum PriceDirection {
  UP_ABSOLUTE, // Always going up (absolute value)
  DOWN_ABSOLUTE, // Always going down (absolute value)
  UP_PERCENTAGE, // Always going up (percentage value)
  DOWN_PERCENTAGE, // Always going down (percentage value)
  RANDOM, // Randomly goes up or down (minimum $1)
  STABLE // Fixed value
}

type PriceDirectionFunction = (price: BigNumber, priceChange: BigNumber) => BigNumber

const PriceDirectionFunctions: Record<PriceDirection, PriceDirectionFunction> = {
  [PriceDirection.UP_ABSOLUTE]: (price: BigNumber, priceChange: BigNumber) => {
    return price.plus(priceChange)
  },
  [PriceDirection.DOWN_ABSOLUTE]: (price: BigNumber, priceChange: BigNumber) => {
    return price.minus(priceChange)
  },
  [PriceDirection.UP_PERCENTAGE]: (price: BigNumber, priceChange: BigNumber) => {
    return price.plus(price.times(priceChange))
  },
  [PriceDirection.DOWN_PERCENTAGE]: (price: BigNumber, priceChange: BigNumber) => {
    return price.minus(price.times(priceChange))
  },
  [PriceDirection.RANDOM]: (price: BigNumber, priceChange: BigNumber) => {
    const change = price.times(priceChange)
    if (Math.random() > 0.5 || price.lt(1)) {
      return price.plus(change)
    }
    return price.minus(change)
  },
  [PriceDirection.STABLE]: (price: BigNumber, priceChange: BigNumber) => {
    return price
  }
}

interface SimulatedOracleFeed {
  token: string
  amount: BigNumber
  change: BigNumber
  direction: PriceDirection
}

interface MasternodeSetup {
  address: string
  privKey: string
}

export class CoinbaseFeeRateProvider implements FeeRateProvider {
  constructor (
    public readonly apiClient: ApiClient
  ) {
  }

  async estimate (): Promise<BigNumber> {
    const result = await this.apiClient.mining.estimateSmartFee(1)
    if (result.feerate === undefined || (result.errors !== undefined && result.errors.length > 0)) {
      return new BigNumber('0.00005000')
    }
    return new BigNumber(result.feerate)
  }
}

export class CoinbasePrevoutProvider implements PrevoutProvider {
  constructor (
    public readonly apiClient: ApiClient,
    public ellipticPair: EllipticPair
  ) {
  }

  async collect (minBalance: BigNumber): Promise<Prevout[]> {
    const pubKey = await this.ellipticPair.publicKey()
    const address = Bech32.fromPubKey(pubKey, 'bcrt')

    const unspent: any[] = await this.apiClient.wallet.listUnspent(
      1, 9999999, { addresses: [address] }
    )

    return unspent.map((utxo: any): Prevout => {
      return CoinbasePrevoutProvider.mapPrevout(utxo, pubKey)
    })
  }

  async all (): Promise<Prevout[]> {
    const pubKey = await this.ellipticPair.publicKey()
    const unspent: any[] = await this.apiClient.wallet.listUnspent(
      1, 9999999, {
        addresses: [Bech32.fromPubKey(pubKey, 'bcrt')]
      })

    return unspent.map((utxo: any): Prevout => {
      return CoinbasePrevoutProvider.mapPrevout(utxo, pubKey)
    })
  }

  static mapPrevout (utxo: any, pubKey: Buffer): Prevout {
    return {
      txid: utxo.txid,
      vout: utxo.vout,
      value: new BigNumber(utxo.amount),
      script: {
        stack: [
          OP_CODES.OP_0,
          OP_CODES.OP_PUSHDATA(HASH160(pubKey), 'little')
        ]
      },
      tokenId: utxo.tokenId
    }
  }
}

export class CoinbaseEllipticPairProvider implements EllipticPairProvider {
  constructor (
    public ellipticPair: EllipticPair
  ) {
  }

  async script (): Promise<Script> {
    return {
      stack: [
        OP_CODES.OP_0,
        OP_CODES.OP_PUSHDATA(HASH160(await this.ellipticPair.publicKey()), 'little')
      ]
    }
  }

  get (prevout: Prevout): EllipticPair {
    return this.ellipticPair
  }
}

export class CoinbaseProviders {
  PRIV_KEY = RegTestFoundationKeys[RegTestFoundationKeys.length - 1].owner.privKey
  fee: CoinbaseFeeRateProvider
  prevout: CoinbasePrevoutProvider
  elliptic: CoinbaseEllipticPairProvider
  ellipticPair: EllipticPair = Elliptic.fromPrivKey(WIF.decode(this.PRIV_KEY).privateKey)

  constructor (readonly apiClient: ApiClient) {
    this.fee = new CoinbaseFeeRateProvider(apiClient)
    this.elliptic = new CoinbaseEllipticPairProvider(this.ellipticPair)
    this.prevout = new CoinbasePrevoutProvider(apiClient, this.ellipticPair)
  }

  setEllipticPair (ellipticPair: EllipticPair): void {
    this.ellipticPair = ellipticPair
    this.elliptic.ellipticPair = this.ellipticPair
    this.prevout.ellipticPair = this.ellipticPair
  }

  async getAddress (): Promise<string> {
    const pubKey = await this.ellipticPair.publicKey()
    return Bech32.fromPubKey(pubKey, 'bcrt', 0x00)
  }
}

export class GenesisCoinbaseBot extends AbstractBot {
  static MN_KEY = RegTestFoundationKeys[RegTestFoundationKeys.length - 1]
  OWNER_ADDR = GenesisCoinbaseBot.MN_KEY.owner.address
  OWNER_PRIV = GenesisCoinbaseBot.MN_KEY.owner.privKey

  providers = new CoinbaseProviders(this.apiClient)
  builder = new P2WPKHTransactionBuilder(
    this.providers.fee,
    this.providers.prevout,
    this.providers.elliptic,
    RegTest
  )

  oracleIds: string[] = []

  feeds: SimulatedOracleFeed[] = [
    {
      token: 'CU10',
      amount: new BigNumber(10),
      change: new BigNumber(0.0001),
      direction: PriceDirection.UP_PERCENTAGE
    },
    {
      token: 'TU10',
      amount: new BigNumber(10),
      change: new BigNumber(0.0001),
      direction: PriceDirection.UP_PERCENTAGE
    },
    {
      token: 'CD10',
      amount: new BigNumber(1000000000),
      change: new BigNumber(0.0001),
      direction: PriceDirection.DOWN_PERCENTAGE
    },
    {
      token: 'TD10',
      amount: new BigNumber(1000000000),
      change: new BigNumber(0.0001),
      direction: PriceDirection.DOWN_PERCENTAGE
    },
    {
      token: 'CS25',
      amount: new BigNumber(25),
      change: new BigNumber(0),
      direction: PriceDirection.STABLE
    },
    {
      token: 'TS25',
      amount: new BigNumber(25),
      change: new BigNumber(0),
      direction: PriceDirection.STABLE
    },
    {
      token: 'CR50',
      amount: new BigNumber(1000),
      change: new BigNumber(0.33),
      direction: PriceDirection.RANDOM
    },
    {
      token: 'TR50',
      amount: new BigNumber(1000),
      change: new BigNumber(0.33),
      direction: PriceDirection.RANDOM
    },
    {
      token: 'DFI',
      amount: new BigNumber(100),
      change: new BigNumber(0),
      direction: PriceDirection.STABLE
    },
    {
      token: 'BTC',
      amount: new BigNumber(50),
      change: new BigNumber(0),
      direction: PriceDirection.STABLE
    },
    {
      token: 'ETH',
      amount: new BigNumber(10),
      change: new BigNumber(0),
      direction: PriceDirection.STABLE
    },
    {
      token: 'USDC',
      amount: new BigNumber(1),
      change: new BigNumber(0),
      direction: PriceDirection.STABLE
    },
    {
      token: 'USDT',
      amount: new BigNumber(0.99),
      change: new BigNumber(0),
      direction: PriceDirection.STABLE
    }
  ]

  private async generateToAddress (): Promise<void> {
    await this.apiClient.call('generatetoaddress', [1, this.OWNER_ADDR, 1], 'number')
  }

  async fund (amount: number, method?: string): Promise<void> {
    // TODO(canonbrother): craft tx
    await this.apiClient.wallet.sendToAddress(this.OWNER_ADDR, amount)
    await this.generateToAddress()

    const pubKey = await this.providers.ellipticPair.publicKey()
    const unspent: any[] = await this.apiClient.wallet.listUnspent(
      1, 9999999, { addresses: [Bech32.fromPubKey(pubKey, 'bcrt')] }
    )
    if (unspent.length === 0) {
      await this.fund(amount, 'dex')
    }
  }

  /**
   * @param {number} balance to wait for wallet to reach
   */
  protected async waitForBalance (balance: number): Promise<void> {
    let current = await this.apiClient.wallet.getBalance()
    while (current.lt(balance)) {
      this.logger.info('waitForBalance', `current balance: ${current.toFixed(8)}, generate to balance: ${balance}`)
      await this.generateToAddress()
      current = await this.apiClient.wallet.getBalance()
    }
  }

  async setupTokens (): Promise<void> {
    const list = [
      {
        create: {
          symbol: 'BTC',
          name: 'Playground BTC',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        // 0.00000785 is added for calculateFeeP2WPKH deduction, 11(total) - 1(creationFee) = 10(collateralAmount)
        fee: 11 + 0.00000785
      },
      {
        create: {
          symbol: 'ETH',
          name: 'Playground ETH',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        fee: 11 + 0.00000785
      },
      {
        create: {
          symbol: 'USDT',
          name: 'Playground USDT',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        fee: 11 + 0.00000795
      },
      {
        create: {
          symbol: 'LTC',
          name: 'Playground LTC',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        fee: 11 + 0.00000785
      },
      {
        create: {
          symbol: 'USDC',
          name: 'Playground USDC',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        fee: 11 + 0.00000795
      },
      {
        create: {
          symbol: 'CU10',
          name: 'Playground CU10',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        fee: 11 + 0.00000795
      },
      {
        create: {
          symbol: 'CD10',
          name: 'Playground CD10',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        fee: 11 + 0.00000795
      },
      {
        create: {
          symbol: 'CS25',
          name: 'Playground CS25',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        fee: 11 + 0.00000795
      },
      {
        create: {
          symbol: 'CR50',
          name: 'Playground CR50',
          decimal: 8,
          limit: new BigNumber(0),
          isDAT: true,
          tradeable: true,
          mintable: true
        },
        fee: 11 + 0.00000795
      }
    ]

    const script = await this.providers.elliptic.script()

    for (const each of list) {
      await this.fund(each.fee)
      const tx = await this.builder.token.createToken(each.create, script)
      await this.sendTransaction(tx)
    }

    await this.generateToAddress()
  }

  async setupLoanSchemes (): Promise<void> {
    const list = [
      {
        ratio: 100,
        rate: new BigNumber(10),
        identifier: 'default',
        update: new BigNumber(0)
      },
      {
        ratio: 150,
        rate: new BigNumber(5),
        identifier: 'MIN150',
        update: new BigNumber(0)
      },
      {
        ratio: 175,
        rate: new BigNumber(3),
        identifier: 'MIN175',
        update: new BigNumber(0)
      },
      {
        ratio: 200,
        rate: new BigNumber(2),
        identifier: 'MIN200',
        update: new BigNumber(0)
      },
      {
        ratio: 350,
        rate: new BigNumber(1.5),
        identifier: 'MIN350',
        update: new BigNumber(0)
      },
      {
        ratio: 500,
        rate: new BigNumber(1),
        identifier: 'MIN500',
        update: new BigNumber(0)
      },
      {
        ratio: 1000,
        rate: new BigNumber(0.5),
        identifier: 'MIN10000',
        update: new BigNumber(0)
      }
    ]

    const script = await this.providers.elliptic.script()

    for (const each of list) {
      await this.fund(1)
      const tx = await this.builder.loans.setLoanScheme(each, script)
      await this.sendTransaction(tx)
    }

    await this.generateToAddress()
  }

  async setupOracles (): Promise<void> {
    const FEEDS: OraclePriceFeed[] = [
      {
        token: 'TSLA',
        currency: 'USD'
      },
      {
        token: 'AAPL',
        currency: 'USD'
      },
      {
        token: 'FB',
        currency: 'USD'
      },
      {
        token: 'CU10',
        currency: 'USD'
      },
      {
        token: 'TU10',
        currency: 'USD'
      },
      {
        token: 'CD10',
        currency: 'USD'
      },
      {
        token: 'TD10',
        currency: 'USD'
      },
      {
        token: 'CS25',
        currency: 'USD'
      },
      {
        token: 'TS25',
        currency: 'USD'
      },
      {
        token: 'CR50',
        currency: 'USD'
      },
      {
        token: 'TR50',
        currency: 'USD'
      },
      {
        token: 'DFI',
        currency: 'USD'
      },
      {
        token: 'BTC',
        currency: 'USD'
      },
      {
        token: 'ETH',
        currency: 'USD'
      },
      {
        token: 'USDC',
        currency: 'USD'
      },
      {
        token: 'USDT',
        currency: 'USD'
      }
    ]
    const script = await this.providers.elliptic.script()
    const list: AppointOracle[] = [
      {
        script: script,
        weightage: 1,
        priceFeeds: FEEDS
      },
      {
        script: script,
        weightage: 1,
        priceFeeds: FEEDS
      },
      {
        script: script,
        weightage: 1,
        priceFeeds: FEEDS
      }
    ]

    for (const each of list) {
      await this.fund(1)
      const tx = await this.builder.oracles.appointOracle(each, script)
      const txid = await this.sendTransaction(tx)
      this.oracleIds.push(txid)
    }

    await this.generateToAddress()
  }

  async setupOracleData (): Promise<void> {
    const script = await this.providers.elliptic.script()

    for (const oracleId of this.oracleIds) {
      const time = Math.floor(Date.now() / 1000)
      await this.fund(1)

      const tx = await this.builder.oracles.setOracleData({
        oracleId: oracleId,
        timestamp: new BigNumber(time),
        tokens: this.feeds
          .filter(value => {
            return value.amount.gt(new BigNumber(0.00000001)) && value.amount.lt(new BigNumber(1_200_000_000))
          })
          .map(v => ({
            token: v.token,
            prices: [{
              amount: v.amount,
              currency: 'USD'
            }]
          }))
      }, script)

      await this.sendTransaction(tx)

      // remap
      this.feeds = this.feeds.map(value => {
        const func = PriceDirectionFunctions[value.direction]
        return {
          ...value,
          amount: func(value.amount, value.change)
        }
      })
    }
  }

  async setupCollateralTokens (): Promise<void> {
    const list: SetCollateralToken[] = [
      {
        token: 0,
        currencyPair: { token: 'DFI', currency: 'USD' },
        factor: new BigNumber('1'),
        activateAfterBlock: 0
      },
      {
        token: 1,
        currencyPair: { token: 'BTC', currency: 'USD' },
        factor: new BigNumber('1'),
        activateAfterBlock: 0
      },
      {
        token: 2,
        currencyPair: { token: 'ETH', currency: 'USD' },
        factor: new BigNumber('0.7'),
        activateAfterBlock: 0
      },
      {
        token: 5,
        currencyPair: { token: 'USDC', currency: 'USD' },
        factor: new BigNumber('1'),
        activateAfterBlock: 0
      },
      {
        token: 3,
        currencyPair: { token: 'USDT', currency: 'USD' },
        factor: new BigNumber('1'),
        activateAfterBlock: 0
      },
      {
        token: 6,
        currencyPair: { token: 'CU10', currency: 'USD' },
        factor: new BigNumber('1'),
        activateAfterBlock: 0
      },
      {
        token: 7,
        currencyPair: { token: 'CD10', currency: 'USD' },
        factor: new BigNumber('1'),
        activateAfterBlock: 0
      },
      {
        token: 8,
        currencyPair: { token: 'CS25', currency: 'USD' },
        factor: new BigNumber('1'),
        activateAfterBlock: 0
      },
      {
        token: 9,
        currencyPair: { token: 'CR50', currency: 'USD' },
        factor: new BigNumber('1'),
        activateAfterBlock: 0
      }
    ]

    const script = await this.providers.elliptic.script()

    for (const each of list) {
      await this.fund(1)
      const tx = await this.builder.loans.setCollateralToken(each, script)
      await this.sendTransaction(tx)
    }

    await this.generateToAddress()
  }

  async setupLoanTokens (): Promise<void> {
    const list: SetLoanToken[] = [
      {
        symbol: 'DUSD',
        name: 'Decentralized USD',
        currencyPair: { token: 'DUSD', currency: 'USD' },
        mintable: true,
        interest: new BigNumber(0)
      },
      {
        symbol: 'TU10',
        name: 'Decentralized TU10',
        currencyPair: { token: 'TU10', currency: 'USD' },
        mintable: true,
        interest: new BigNumber(1)
      },
      {
        symbol: 'TD10',
        name: 'Decentralized TD10',
        currencyPair: { token: 'TD10', currency: 'USD' },
        mintable: true,
        interest: new BigNumber(1.5)
      },
      {
        symbol: 'TS25',
        name: 'Decentralized TS25',
        currencyPair: { token: 'TS25', currency: 'USD' },
        mintable: true,
        interest: new BigNumber(2)
      },
      {
        symbol: 'TR50',
        name: 'Decentralized TR50',
        currencyPair: { token: 'TR50', currency: 'USD' },
        mintable: true,
        interest: new BigNumber(3)
      }
    ]

    const script = await this.providers.elliptic.script()

    for (const each of list) {
      await this.fund(1)
      const tx = await this.builder.loans.setLoanToken(each, script)
      await this.sendTransaction(tx)
    }

    await this.generateToAddress()
  }

  async setupDex (): Promise<void> {
    const script = await this.providers.elliptic.script()

    const list: PoolCreatePair[] = [
      {
        tokenA: 1, // BTC
        tokenB: 0, // DFI
        commission: new BigNumber(0),
        ownerAddress: script,
        status: true,
        pairSymbol: 'BTC-DFI',
        customRewards: []
      },
      {
        tokenA: 2, // ETH
        tokenB: 0, // DFI
        commission: new BigNumber(0),
        ownerAddress: script,
        status: true,
        pairSymbol: 'ETH-DFI',
        customRewards: []
      },
      {
        tokenA: 3, // USDT
        tokenB: 0, // DFI
        commission: new BigNumber(0),
        ownerAddress: script,
        status: true,
        pairSymbol: 'USDT-DFI',
        customRewards: []
      },
      {
        tokenA: 4, // LTC
        tokenB: 0, // DFI
        commission: new BigNumber(0),
        ownerAddress: script,
        status: true,
        pairSymbol: 'LTC-DFI',
        customRewards: []
      },
      {
        tokenA: 5, // USDC
        tokenB: 0, // DFI
        commission: new BigNumber(0),
        ownerAddress: script,
        status: true,
        pairSymbol: 'USDC-DFI',
        customRewards: []
      },
      {
        tokenA: 10, // DUSD
        tokenB: 0, // DUSD
        commission: new BigNumber(0),
        ownerAddress: script,
        status: true,
        pairSymbol: 'DUSD-DFI',
        customRewards: []
      },
      {
        tokenA: 11, // TU10
        tokenB: 10, // DUSD
        commission: new BigNumber(0),
        ownerAddress: script,
        status: true,
        pairSymbol: 'TU10-DFI',
        customRewards: []
      },
      {
        tokenA: 12, // TD10
        tokenB: 10, // DUSD
        commission: new BigNumber(0),
        ownerAddress: script,
        status: true,
        pairSymbol: 'TD10-DFI',
        customRewards: []
      },
      {
        tokenA: 13, // TS25
        tokenB: 10, // DUSD
        commission: new BigNumber(0.02),
        ownerAddress: script,
        status: true,
        pairSymbol: 'TS25-DUSD',
        customRewards: []
      }
    ]

    for (const each of list) {
      await this.fund(1, 'dex')
      const tx = await this.builder.dex.createPoolPair(each, script)
      await this.sendTransaction(tx)
    }

    await this.generateToAddress()
  }

  async setupMasterNodes (): Promise<void> {
    const list: MasternodeSetup[] = [
      {
        address: 'bcrt1qda8rxjyepjcj6dx82sxce3srvv4h2qcz5pjzp0',
        privKey: 'cPEKM7uMPJxbCpsjLfWuuwkQFP99DgEbBdmUX5xTppe2ibABuWWf'
      },
      {
        address: 'bcrt1qg0ppznzvc6wkp263ldwsss3w4fmx0jkg98snff',
        privKey: 'cPVwHKcMmE3YrJfdna8t33kiJfEg2oFjJSvHJimshj84xThqV9zi'
      }
    ]

    await this.waitForBalance(20001)

    const script = await this.providers.elliptic.script()

    for (const each of list) {
      // craft tx
      await this.apiClient.wallet.importPrivKey(each.privKey)

      await this.fund(3 + 0.00000755)

      const addressDest: P2WPKH = P2WPKH.fromAddress(RegTest, each.address, P2WPKH)
      const addressDestKeyHash = addressDest.pubKeyHash

      const tx = await this.builder.masternode.create({
        operatorType: 0x04,
        operatorPubKeyHash: addressDestKeyHash
      }, script)
      const txid = await this.sendTransaction(tx)
      console.log('txid: ', txid)
    }

    await this.generateToAddress()
  }

  async setup (): Promise<void> {
    await this.setupTokens()
    await this.setupLoanSchemes()
    await this.setupOracles()
    // await new Promise(resolve => setInterval(() => resolve(this.setupOracleData()), 6000))
    await this.setupOracleData()
    await this.setupCollateralTokens()
    await this.setupLoanTokens()
    await this.setupDex()
    // await this.setupMasterNodes()
  }

  async sendTransaction (transaction: TransactionSegWit): Promise<string> {
    const buffer = new SmartBuffer()
    new CTransactionSegWit(transaction).toBuffer(buffer)
    const hex = buffer.toBuffer().toString('hex')
    return await this.apiClient.rawtx.sendRawTransaction(hex)
  }

  async bootstrap (): Promise<void> {
    await this.setup()
  }

  async cycle (n: number): Promise<void> {
  }
}
