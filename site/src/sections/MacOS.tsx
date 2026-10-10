/** A Mac window's close, minimise and zoom buttons; greyed when the window isn't focused. */
export function TrafficLights({ dim }: { dim?: boolean }) {
  return (
    <div className="flex gap-2">
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <span
          key={c}
          className="h-3 w-3 rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/.12)]"
          style={{ background: dim ? "rgb(var(--line-strong))" : c }}
        />
      ))}
    </div>
  );
}
