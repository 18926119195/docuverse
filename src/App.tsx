import { CvsScene } from './canvas/CvsScene'
import { HUD } from './ui/HUD'
import { KeyboardNav } from './ui/KeyboardNav'
import { A1ChatDock } from './ui/A1ChatDock'
import { WorkbenchPalette } from './ui/WorkbenchPalette'
import { EmphasisStarMap } from './ui/EmphasisStarMap'
import { OverviewLinkBoard } from './ui/OverviewLinkBoard'
import { KeyHashGraph } from './ui/KeyHashGraph'
import './App.css'

/**
 * PDF stage (bookKey surface) + A1→Flash chat + key-hash attention rail.
 * 强调笔 / 星图 / 关联台 kept and co-exist with the key graph.
 * Attention expands in-place on Δ chips (BookKeyHashLinks), not a center modal.
 */
export default function App() {
  return (
    <div className="app-root">
      <KeyboardNav />
      <main className="stage">
        <CvsScene />
      </main>
      <HUD />
      <A1ChatDock />
      <KeyHashGraph />
      <WorkbenchPalette />
      <EmphasisStarMap />
      <OverviewLinkBoard />
      <footer className="patent-bar">
        左键拖拽 · 右键环视 · 滚轮缩放 · A1→Flash · Space+G 星图+笔 · Esc 工作台
      </footer>
    </div>
  )
}
