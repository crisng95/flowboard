import { useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Board } from "./canvas/Board";
import { AddNodePalette } from "./canvas/AddNodePalette";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
import { ToolbarV2 } from "./components/ToolbarV2";
// import { ChatSidebar } from "./components/ChatSidebar";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectSidebarV2 } from "./components/ProjectSidebarV2";
import { Toaster } from "./components/Toaster";
import { GenerationDialog } from "./components/GenerationDialog";
import { ResultViewer } from "./components/ResultViewer";
import { ResultViewerV2 } from "./components/ResultViewerV2";
import { ForcedSetupGate } from "./components/ForcedSetupGate";
import { useBoardStore } from "./store/board";
import { getUiVersion } from "./lib/utils";

const useV2Toolbar = getUiVersion() === "v2";
const useV2Sidebar = getUiVersion() === "v2";

export function App() {
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    loadInitialBoard();
  }, [loadInitialBoard]);

  return (
    <div className="app">
      {useV2Sidebar ? <ProjectSidebarV2 /> : <ProjectSidebar />}
      <ReactFlowProvider>
        <div className="canvas-wrap">
          {useV2Toolbar ? <ToolbarV2 /> : <Toolbar />}
          {loading && boardId === null ? (
            <div className="canvas-loading">Loading board…</div>
          ) : (
            <>
              <Board />
              <AddNodePalette />
            </>
          )}
          <StatusBar />
        </div>
      </ReactFlowProvider>
      {/* <ChatSidebar /> */}
      <Toaster />
      <GenerationDialog />
      {useV2Sidebar ? <ResultViewerV2 /> : <ResultViewer />}
      <ForcedSetupGate />
    </div>
  );
}
