import { useRef, useState } from "react";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

/** 数据面板：导出/导入学习进度（localStorage → JSON 文件） */
export default function DataPanel({ progress, onClose }: { progress: Progress; onClose: () => void }) {
  const { exportData, importData } = progress;
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  /** 导入前确认（覆盖是破坏性操作，评审 M） */
  const [pendingFile, setPendingFile] = useState<{ name: string; json: string } | null>(null);

  const download = () => {
    const blob = new Blob([exportData()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aiforge-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus({ ok: true, message: "已下载导出文件，请妥善保存" });
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setPendingFile({ name: f.name, json: text });
    setStatus(null);
  };

  const confirmImport = () => {
    if (!pendingFile) return;
    const r = importData(pendingFile.json);
    setStatus(r);
    setPendingFile(null);
    if (r.ok) setTimeout(onClose, 1200);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="学习数据管理"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="card__title">学习数据</h2>
        <p className="card__subtitle">
          进度保存在浏览器 localStorage。导出 JSON 文件可防丢失、换机迁移；导入会<b>覆盖</b>当前进度。
        </p>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
          <button className="btn btn--primary" onClick={download}>⬇ 导出进度</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>⬆ 选择导入文件</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden
            onChange={(e) => onFile(e.target.files?.[0])} />
          <button className="btn" onClick={onClose}>关闭</button>
        </div>

        {pendingFile && (
          <div style={{ marginTop: "var(--space-4)", padding: "var(--space-3)", border: "1px solid var(--status-warning)", borderRadius: "var(--radius-s)" }}>
            <p style={{ margin: "0 0 var(--space-2)", fontWeight: 600 }}>
              确认导入 {pendingFile.name}？
            </p>
            <p className="card__subtitle" style={{ margin: 0 }}>
              当前全部进度（清单/闪卡/命令/面试/连续天数）将被此文件内容覆盖，操作不可撤销。
            </p>
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
              <button className="btn btn--primary" onClick={confirmImport}>确认覆盖导入</button>
              <button className="btn" onClick={() => setPendingFile(null)}>取消</button>
            </div>
          </div>
        )}

        {status && (
          <p style={{ marginTop: "var(--space-3)", color: status.ok ? "var(--status-good)" : "var(--status-critical-text)", fontWeight: 600 }} role="status">
            {status.message}
          </p>
        )}
      </div>
    </div>
  );
}
