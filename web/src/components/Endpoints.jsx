export default function Endpoints({ state }) {
  const pub = state?.publicUrl ? state.publicUrl.replace(/\/$/, '') + '/mcp' : '';
  return (
    <section className="glass flex flex-col justify-center gap-5 rounded-[28px] p-6 lg:col-span-5">
      <div className="flex gap-4">
        <div className="flex flex-col items-center py-1.5" aria-hidden="true">
          <i className="size-3 rounded-full border-2 border-route" />
          <i className="my-1 w-px flex-1 border-l border-dashed border-route/60" />
          <i className="size-3 rounded-full border-2 border-mute" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-mute">Public endpoint</span>
              <button
                disabled={!pub}
                onClick={() => navigator.clipboard.writeText(pub)}
                className="shrink-0 rounded-full bg-raised px-3.5 py-1 text-xs font-medium hover:bg-hair focus-visible:outline-2 focus-visible:outline-route disabled:opacity-30 disabled:hover:bg-raised"
              >Copy</button>
            </div>
            <code className="mt-1 block break-all font-mono text-sm">{pub || '-'}</code>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-mute">This computer</div>
            <code className="mt-0.5 block break-all font-mono text-sm text-mute">{state ? `http://localhost:${state.mcpPort}/mcp` : '-'}</code>
          </div>
        </div>
      </div>
    </section>
  );
}
