import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const saved = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  },
  setTimeout,
}
globalThis.localStorage = window.localStorage
const server = await createServer({ root, configFile: false, envFile: false, server: { middlewareMode: true, watch: null, ws: false } })
try {
  const load = (path) => server.ssrLoadModule('/src/' + path + '.ts')
  const { bm25Rank } = await load('reasoning/hybridRetrieve')
  const ranked = bm25Rank('置信区间', ['玻璃金属与树木', '置信区间、区间估计'], 2)
  assert.equal(ranked[0].index, 1)
  const {normalizeIncrementStatus} = await load('arch/keyIncrementStatus')
  assert.deepEqual(
    ['不充分', '不够用', 'not enough', '充分', '未读'].map(normalizeIncrementStatus),
    ['insufficient', 'insufficient', 'insufficient', 'sufficient', 'unread'],
  )
  const {useAttentionIo} = await load('reasoning/attentionIoStore')
  const st = useAttentionIo.getState()
  const current = st.ensureQueryKey('当前问题')
  assert.equal(st.ensureQueryKey(' 当前问题 '), current)
  console.log('BM25 排名、三态及同问复用 queryKey 通过')
  const {inspectQueryGap} = await load('arch/gapNavigation')
  const hist = st.ensureQueryKey('历史问题')
  useAttentionIo.setState({
    neighbours: [{ nowQueryKey: current, historicQueryKey: hist }],
    paths: [{ queryKey: hist, pathKey: 'ph_old' }],
    queryReuseLinks: [],
  })
  const inspect = () => inspectQueryGap({ docId:'smoke', question:'当前问题', queryKey:current })
  assert.equal(inspect().kind, 'reuse')
  useAttentionIo.setState({ queryReuseLinks: [{ fromQueryKey: current, toQueryKey: hist, pathKey:'ph_old' }] })
  assert.equal(inspect().kind, 'brief')
  const {prospectIsomorphicToAny} = await load('reasoning/prospectIsomorph')
  assert.equal(prospectIsomorphicToAny('统计上的置信区间 与相关概念。',['统计上的置信区间与相关概念']), true)
  console.log('复用落账后空位推进与同构闸通过')
} finally {
  await server.close()
}
