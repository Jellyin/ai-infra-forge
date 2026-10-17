import { useEffect, useRef, useState } from "react";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

/** 数据面板：导出/导入学习进度（localStorage → JSON 文件） */
export default function DataPanel({ progress, onClose }: { progress: Progress; onClose: () => void }) {
  const { exportData, importData } = progress;
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  /** 导入前确认（覆盖是破坏性操作，评审 M） */
  const [pendingFile, setPendingFile] = useState<{ name: string; json: string } | null>(null);

  /* 对话框焦点管理：入框 → 圈在框内 → Esc 关闭 → 归还给触发元素。
     aria-modal 只是声明，不隔离背景，必须自己做。 */
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const SEL = 'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const f = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(SEL))
        .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [onClose]);

  const download = () => {
    const blob = new Blob([exportData()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aiforge-progress-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 同步 revoke 会让 Firefox/Safari 拿到失效 URL（下载 0 字节），让出一轮事件循环再释放
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus({ ok: true, message: "已下载导出文件，请妥善保存" });
  };

  const onFile = async (f: File | undefined, input?: HTMLInputElement) => {
    if (!f) return;
    /* 体积护栏：超大 JSON 在主线程解析会冻结页面（自伤型，但护栏成本极低） */
    const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
    if (f.size > MAX_IMPORT_BYTES) {
      setPendingFile(null);
      setStatus({ ok: false, message: `文件过大（${(f.size / 1024 / 1024).toFixed(1)} MB），上限 10 MB` });
      return;
    }
    const text = await f.text();
    setPendingFile({ name: f.name, json: text });
    setStatus(null);
    input?.focus();
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
        ref={dialogRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <h2 className="card__title">学习数据</h2>
        <p className="card__subtitle">
          进度保存在浏览器 localStorage。导出 JSON 文件可防丢失、换机迁移；导入会<b>覆盖</b>当前进度。
        </p>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
          <button className="btn btn--primary" onClick={download}>⬇ 导出进度</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>⬆ 选择导入文件</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden
            onChange={(e) => {
              const input = e.target;
              onFile(input.files?.[0], input);
              input.value = "";   // 允许重选同一文件（否则 onChange 不再触发）
            }} />
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
