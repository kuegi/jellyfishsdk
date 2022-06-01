import { DeFiDRpcError, MasterNodeRegTestContainer, StartOptions } from '@defichain/testcontainers'
import { Testing } from '@defichain/jellyfish-testing'
import { getProviders, MockProviders } from '../provider.mock'
import { P2WPKHTransactionBuilder } from '../../src'
import { calculateTxid, fundEllipticPair, sendTransaction } from '../test.utils'
import { WIF } from '@defichain/jellyfish-crypto'
import BigNumber from 'bignumber.js'
import { OP_CODES, VoteGov } from '@defichain/jellyfish-transaction'
import { RegTest, RegTestFoundationKeys } from '@defichain/jellyfish-network'

class CustomOperatorMasterNodeRegTestContainer extends MasterNodeRegTestContainer {
  protected getCmd (opts: StartOptions): string[] {
    return [
      ...super.getCmd(opts),
      `-masternode_operator=${RegTestFoundationKeys[RegTestFoundationKeys.length - 1].operator.address}` // Uses masternode_operator with bech32 address to be able to craft vote transaction
    ]
  }
}

describe('vote', () => {
  let providers: MockProviders
  let builder: P2WPKHTransactionBuilder
  const testing = Testing.create(new CustomOperatorMasterNodeRegTestContainer())

  const masternodeOperatorAddress = RegTestFoundationKeys[RegTestFoundationKeys.length - 1].operator.address
  let masternodeId: string

  beforeAll(async () => {
    await testing.container.start()
    await testing.container.waitForWalletCoinbaseMaturity()

    await testing.container.call('importprivkey', [RegTestFoundationKeys[RegTestFoundationKeys.length - 1].operator.privKey, 'operator', true])
    await testing.container.call('importprivkey', [RegTestFoundationKeys[RegTestFoundationKeys.length - 1].owner.privKey, 'owner', true])

    const masternodeList = await testing.rpc.masternode.listMasternodes()
    for (const id in masternodeList) {
      if (masternodeList[id].operatorAuthAddress === masternodeOperatorAddress) {
        masternodeId = id
        break
      }
    }

    providers = await getProviders(testing.container)
    providers.setEllipticPair(WIF.asEllipticPair(RegTestFoundationKeys[RegTestFoundationKeys.length - 1].owner.privKey))
    builder = new P2WPKHTransactionBuilder(providers.fee, providers.prevout, providers.elliptic, RegTest)

    await testing.container.waitForWalletBalanceGTE(12)
    await fundEllipticPair(testing.container, providers.ellipticPair, 50)
    await providers.setupMocks()
  })

  afterAll(async () => {
    await testing.container.stop()
  })

  it('should vote', async () => {
    const script = await providers.elliptic.script()
    const createGovVocTxn = await builder.governance.createGovCfp({
      type: 0x01,
      title: 'community fund proposal',
      context: 'https://github.com/DeFiCh/dfips',
      amount: new BigNumber(10),
      address: script,
      cycles: 2
    }, script)

    const proposalId = calculateTxid(createGovVocTxn)
    await sendTransaction(testing.container, createGovVocTxn)

    await testing.container.generate(1, masternodeOperatorAddress) // Mint one block to be able to vote on proposal

    const vote: VoteGov = {
      voteDecision: 0x01,
      proposalId,
      masternodeId
    }
    const txn = await builder.governance.voteGov(vote, script)

    const encoded: string = OP_CODES.OP_DEFI_TX_VOTE(vote).asBuffer().toString('hex')
    const expectedRedeemScript = `6a${encoded}`

    const outs = await sendTransaction(testing.container, txn)
    expect(outs[0].value).toStrictEqual(0)
    expect(outs[0].scriptPubKey.hex).toStrictEqual(expectedRedeemScript)
  })
})

describe('vote with masternode operator with legacy address', () => {
  let providers: MockProviders
  let builder: P2WPKHTransactionBuilder
  const testing = Testing.create(new MasterNodeRegTestContainer())

  let masternodeId: string
  let masternodeOperatorAddress: string

  beforeAll(async () => {
    await testing.container.start()
    await testing.container.waitForWalletCoinbaseMaturity()

    const masternodeList = await testing.rpc.masternode.listMasternodes()
    for (const id in masternodeList) {
      if (masternodeList[id].localMasternode) {
        masternodeId = id
        masternodeOperatorAddress = masternodeList[id].operatorAuthAddress
        break
      }
    }

    providers = await getProviders(testing.container)
    providers.setEllipticPair(WIF.asEllipticPair(RegTestFoundationKeys[0].owner.privKey))
    builder = new P2WPKHTransactionBuilder(providers.fee, providers.prevout, providers.elliptic, RegTest)

    await testing.container.waitForWalletBalanceGTE(12)
    await fundEllipticPair(testing.container, providers.ellipticPair, 50)
    await providers.setupMocks()
  })

  afterAll(async () => {
    await testing.container.stop()
  })

  it('should not vote without at least one input from the owner', async () => {
    const script = await providers.elliptic.script()
    const createGovVocTxn = await builder.governance.createGovCfp({
      type: 0x01,
      title: 'community fund proposal',
      context: 'https://github.com/DeFiCh/dfips',
      amount: new BigNumber(10),
      address: script,
      cycles: 2
    }, script)
    const proposalId = calculateTxid(createGovVocTxn)

    await sendTransaction(testing.container, createGovVocTxn)

    await testing.container.generate(1, masternodeOperatorAddress) // Mint one block to be able to vote on proposal

    const txn = await builder.governance.voteGov({
      voteDecision: 0x01,
      proposalId,
      masternodeId
    }, script)

    const promise = sendTransaction(testing.container, txn)

    await expect(promise).rejects.toThrow(DeFiDRpcError)
    await expect(promise).rejects.toThrow("DeFiDRpcError: 'VoteTx: tx must have at least one input from the owner (code 16)', code: -26")
  })
})
