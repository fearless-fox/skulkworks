import React from 'react'
import { CanvasContainer } from './components/CanvasContainer'
import { Toolbar } from './components/Toolbar'
import { MetadataPanel } from './components/MetadataPanel'
import { EpochStatus } from './components/EpochStatus'
import { AuthBar } from './components/AuthBar'
import { useCanvasStore } from './store/canvasStore'
import './App.css'

function App() {
  const { connected, authenticated, canvasState } = useCanvasStore()

  return (
    <div className="app">
      <div className="status-bar">
        <div className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? '🟢 Connected' : '🔴 Disconnected'}
        </div>
        {authenticated && (
          <div className="auth-status">✓ Authenticated</div>
        )}
        <EpochStatus state={canvasState} />
      </div>

      <AuthBar />
      <Toolbar />

      <div className="canvas-wrapper">
        <CanvasContainer />
        <MetadataPanel />
      </div>
    </div>
  )
}

export default App
