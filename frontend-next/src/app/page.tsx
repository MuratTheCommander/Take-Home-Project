"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { DataSet } from "vis-data";
import { Timeline } from "vis-timeline/standalone";
import moment from "moment";

export type Operation = {
  id: string;
  workOrderId: string;
  index: number;
  machineId: string;
  name: string;
  start: string; // ISO-8601 UTC
  end: string;   // ISO-8601 UTC
};

export type WorkOrder = {
  id: string;
  product: string;
  qty: number;
  operations: Operation[];
};

const API_BASE = "http://localhost:8000";

async function fetchWorkOrders(): Promise<WorkOrder[]> {
  const r = await fetch(`${API_BASE}/workorders`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to fetch work orders: ${r.status}`);
  return r.json();
}

/** Ensure string parses as UTC (append Z if missing). */
function toUtcDate(s: string): Date {
  const hasTZ = /Z|[+-]\d{2}:\d{2}$/.test(s);
  return new Date(hasTZ ? s : s + "Z");
}

/** ISO string with trimmed .000 */
const fmtUTC = (d: Date) => d.toISOString().replace(".000", "");

/** Strict ISO-8601 UTC validator (YYYY-MM-DDTHH:mm:ssZ) */
function validateIsoUtc(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return "Use format YYYY-MM-DDTHH:mm:ssZ (UTC)";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "Invalid date/time";
  if (s !== fmtUTC(d)) return "Seconds required; no millis; must end with Z";
  return null;
}

/** Minimal type for vis-timeline click events */
type ClickProps = {
  what: "item" | "background" | string;
  item?: string | number;
  event?: MouseEvent & { target: EventTarget & Element };
};

type TimelineItem = {
  id: string;
  group: string;
  start: Date;
  end: Date;
  title: string;
  content: string;
  className: string;
  _wo: string;
  _name: string;
};

export default function TimelineApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<Timeline | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [highlightWO, setHighlightWO] = useState<string | null>(null);

  // Update Panel state
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedOpId, setSelectedOpId] = useState<string | null>(null);
  const [formStart, setFormStart] = useState<string>(""); // raw ISO UTC
  const [formEnd, setFormEnd] = useState<string>("");     // raw ISO UTC
  const [saving, setSaving] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  // Client-side inline validation
  const startErr = formStart ? validateIsoUtc(formStart) : "Start required";
  const endErr = formEnd ? validateIsoUtc(formEnd) : "End required";
  const intervalErr = !startErr && !endErr && new Date(formStart) >= new Date(formEnd) ? "Start must be before end" : null;
  const canSave = !startErr && !endErr && !intervalErr && !saving;

  // Build groups/items for vis
  const { groupsDataSet, itemsDataSet } = useMemo(() => {
    const groups = new DataSet<{ id: string; content: string }>([]);
    const items = new DataSet<TimelineItem>([]);

    const machines = new Set<string>();
    workOrders.forEach((wo) => wo.operations.forEach((op) => machines.add(op.machineId)));
    [...machines].sort().forEach((machineId) => groups.add({ id: machineId, content: machineId }));

    workOrders.forEach((wo) => {
      wo.operations.forEach((op) => {
        const s = toUtcDate(op.start);
        const e = toUtcDate(op.end);
        items.add({
          id: op.id,
          group: op.machineId,
          start: s,
          end: e,
          title: `${wo.id} · ${op.name}\nUTC: ${fmtUTC(s)} → ${fmtUTC(e)}`,
          content: `${wo.id} · ${op.name}`,
          className: `wo-${wo.id}`,
          _wo: wo.id,
          _name: op.name,
        });
      });
    });

    return { groupsDataSet: groups, itemsDataSet: items };
  }, [workOrders]);

  // Initial fetch
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    fetchWorkOrders()
      .then((data) => { if (mounted) setWorkOrders(data); })
      .catch((e) => { if (mounted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  async function putOperation(opId: string, startISO: string, endISO: string) {
    const r = await fetch(`${API_BASE}/operations/${opId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: startISO, end: endISO })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = (data as any)?.error || (data as any)?.detail?.error || {};
      const msg = (err as any).message || `Update failed (${r.status})`;
      const rule = (err as any).rule ? `${(err as any).rule}: ` : "";
      throw new Error(rule + msg);
    }
    return (data as any)?.data as { id: string; start: string; end: string };
  }

  // (Re)build timeline
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (timelineRef.current) {
      try { timelineRef.current.destroy(); } catch { }
      timelineRef.current = null;
    }

    const timeline = new Timeline(
      el,
      itemsDataSet,
      groupsDataSet,
      {
        stack: false,
        horizontalScroll: true,
        zoomKey: "ctrlKey",
        showCurrentTime: true,
        multiselect: false,
        selectable: true,
        orientation: "top",
        margin: { item: 12, axis: 12 },
        moment: (date: unknown) => moment(date as Date).utc(), // axis in UTC
        editable: { // 🔧 enable drag/resize editing
          updateTime: true,
          overrideItems: false,
        },
        onMove: function (item: any, callback: (item?: any) => void) {
          // Optimistic ghost move; we confirm in rangechanged
          callback(item);
        },
        onMoving: function () { /* can add snapping here */ },
        onUpdate: function (item: any, callback: (item?: any) => void) {
          // resize end; accept temp, will persist in rangechanged
          callback(item);
        },
      } as any
    );

    // Click to highlight same WO and open panel
    timeline.on("click", (props: ClickProps) => {
      if (props.what === "background" || !props.item) {
        clearHighlightAndPanel();
        return;
      }
      const dsItem = itemsDataSet.get(props.item as string) as { _wo?: string } | null;
      const woId = dsItem?._wo ?? null;
      if (!woId) {
        clearHighlightAndPanel();
        return;
      }
      const sameWoIds = (itemsDataSet.get({ filter: (it: any) => it && it._wo === woId }) as Array<{ id: string }>).map((it) => it.id);
      timeline.setSelection(sameWoIds, { focus: false });
      setHighlightWO(woId);

      const clickedId = String(props.item);
      const clicked = itemsDataSet.get(clickedId) as any;
      if (clicked) {
        setSelectedOpId(clickedId);
        setPanelError(null);
        setPanelOpen(true);
        setFormStart(fmtUTC(clicked.start));
        setFormEnd(fmtUTC(clicked.end));
      }
    });


    // Persist edits after a drag/resize finishes
    let lastBefore: Record<string, { start: Date; end: Date }> = {};
    timeline.on("rangechange", () => { /* noop */ });

    timeline.on("rangechanged", async () => { /* noop (axis zoom/pan end) */ });

    timeline.on("changed", async () => { /* called after items change */ });

    // vis-timeline emits item-specific events; hook into data changes via DataSet
    itemsDataSet.on("update", async ({ items }) => {
      // When user drags/resizes, DataSet receives updates. Detect a single-item edit.
      if (!items || items.length !== 1) return;
      const id = String(items[0]);
      const it = itemsDataSet.get(id) as any;
      if (!it) return;

      // Prevent feedback loop: if we initiated programmatic update after a save, skip
      if ((it as any)._saving) return;

      // Optimistic save: attempt backend update with the new times
      try {
        const saved = await putOperation(id, fmtUTC(it.start), fmtUTC(it.end));
        itemsDataSet.update({ id, start: new Date(saved.start), end: new Date(saved.end) });
      } catch (e) {
        // Revert on failure
        const prev = lastBefore[id];
        if (prev) itemsDataSet.update({ id, start: prev.start, end: prev.end });
        toastError((e as Error).message);
      } finally {
        delete lastBefore[id];
      }
    });

    // Snapshot positions before any user move/resize so we can revert cleanly
    itemsDataSet.on("update", ({ items, oldData }) => {
      if (!items || items.length !== 1) return;
      const id = String(items[0]);
      if (!oldData || !oldData[0]) return;
      lastBefore[id] = { start: oldData[0].start, end: oldData[0].end };
    });

    timelineRef.current = timeline;

    // Fit to items (with padding)
    try {
      const all = (itemsDataSet.get() as any[]) || [];
      if (all.length > 0) {
        const min = new Date(Math.min(...all.map(i => (i.start as Date).getTime())));
        const max = new Date(Math.max(...all.map(i => (i.end as Date).getTime())));
        const span = Math.max(1, max.getTime() - min.getTime());
        const pad = Math.max(span * 0.1, 15 * 60 * 1000);
        timeline.setWindow(new Date(min.getTime() - pad), new Date(max.getTime() + pad), { animation: false });
      } else {
        timeline.fit({ animation: false });
      }
    } catch { }

    // "Now (UTC)" marker
    let tick: number | undefined;
    try {
      const NOW_ID = "now-utc-label";
      timeline.addCustomTime(new Date(), NOW_ID);
      (timeline as any).setCustomTimeMarker?.("Now (UTC)", NOW_ID, true);
      const updateNow = () => { try { timeline.setCustomTime(new Date(), NOW_ID); } catch { } };
      updateNow();
      tick = window.setInterval(updateNow, 30_000);
    } catch { }

    return () => {
      if (tick) window.clearInterval(tick);
      try { timeline.destroy(); } catch { }
      timelineRef.current = null;
    };
  }, [groupsDataSet, itemsDataSet]);

  // Dimming toggle via data-attr
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (highlightWO) el.setAttribute("data-dim", "true");
    else el.removeAttribute("data-dim");
  }, [highlightWO]);

  // Clear when clicking anywhere not on a bar or the centered panel content
  useEffect(() => {
    const onGlobalPointerDown = (ev: PointerEvent) => {
      if (!highlightWO && !panelOpen) return;
      const target = ev.target as Element | null;
      if (!target) return;
      const isOnItem = !!target.closest(".vis-item");
      const isOnPanelContent = !!target.closest('[data-role="update-panel"]');
      if (isOnItem || isOnPanelContent) return;
      clearHighlightAndPanel();
    };
    window.addEventListener("pointerdown", onGlobalPointerDown, true);
    return () => window.removeEventListener("pointerdown", onGlobalPointerDown, true);
  }, [highlightWO, panelOpen]);

  const clearHighlightAndPanel = () => {
    setHighlightWO(null);
    setPanelOpen(false);
    setSelectedOpId(null);
    setPanelError(null);
    timelineRef.current?.setSelection([]);
  };

  const handleRefresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setWorkOrders(await fetchWorkOrders());
      clearHighlightAndPanel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // ----- Panel save (validated) -----
  const handleSave = async () => {
    if (!selectedOpId || !canSave) return;
    setSaving(true);
    setPanelError(null);
    try {
      const saved = await putOperation(selectedOpId, formStart, formEnd);
      // Mark to avoid feedback loop
      (itemsDataSet as any).update({ id: selectedOpId, start: new Date(saved.start), end: new Date(saved.end), _saving: true });
      setPanelOpen(false);
      setSelectedOpId(null);
    } catch (e) {
      setPanelError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Quick nudge helpers (± minutes)
  function nudge(which: "start" | "end", mins: number) {
    const s = which === "start" ? formStart : formEnd;
    const err = validateIsoUtc(s);
    if (err) return;
    const d = new Date(s);
    d.setUTCMinutes(d.getUTCMinutes() + mins);
    const v = fmtUTC(d);
    if (which === "start") setFormStart(v); else setFormEnd(v);
  }

  // Simple toast impl (replace with your UI lib)
  const [toast, setToast] = useState<string | null>(null);
  function toastError(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  }

  return (
    <div className="min-h-screen w-full px-6 py-5">
      <header className="flex items-center justify-between gap-4 mb-4">
        <h1 className="text-2xl font-semibold">Factory Schedule</h1>
        <div className="flex items-center gap-2">
          <button onClick={clearHighlightAndPanel} className="px-3 py-2 rounded-xl border hover:bg-gray-50">Clear highlight</button>
          <button onClick={() => timelineRef.current?.moveTo(new Date(), { animation: false })} className="px-3 py-2 rounded-xl border hover:bg-gray-50">Go to now</button>
          <button onClick={handleRefresh} className="px-3 py-2 rounded-xl border hover:bg-gray-50">Refresh</button>
        </div>
      </header>

      <br />

      {error && <div className="mb-3 text-sm text-red-600 border border-red-200 bg-red-50 p-3 rounded-xl">{error}</div>}
      {loading && <div className="mb-3 text-sm text-gray-600 border border-gray-200 bg-gray-50 p-3 rounded-xl">Loading…</div>}

      <div className="relative">
        {/* Timeline Container */}
        <div ref={containerRef} className="timeline-container border rounded-2xl shadow-sm" style={{ height: 190, background: "white" }} />

        {/* Update Panel positioned directly below timeline */}
        {panelOpen && selectedOpId && (
          <div
            data-role="update-panel"
            className="absolute top-full left-0 right-0 mt-4 bg-white border rounded-2xl shadow-lg p-4 z-50"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">Update Operation (UTC)</h3>
              <button onClick={clearHighlightAndPanel} className="px-2 py-1 rounded-md border hover:bg-gray-50 text-sm">✕</button>
            </div>
            <br />
            <div className="space-y-3">
              <div className="text-sm">
                <div><span className="font-medium">Operation ID:</span> {selectedOpId}</div>
                <br />
                {highlightWO && <div><span className="font-medium">Work Order:</span> {highlightWO}</div>}
              </div>

              <label className="block text-sm">
                <span className="font-medium">Start (YYYY-MM-DDTHH:mm:ssZ)</span>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    className={`w-full border rounded-md px-2 py-1 font-mono text-xs ${startErr ? 'border-red-300' : ''}`}
                    placeholder="2025-08-22T09:00:00Z"
                    value={formStart}
                    onChange={(e) => setFormStart(e.target.value)}
                  />
                  <div className="flex gap-1">
                    <button onClick={() => nudge('start', -15)} className="px-2 py-1 rounded-md border text-xs">−15m</button>
                    <button onClick={() => nudge('start', +15)} className="px-2 py-1 rounded-md border text-xs">+15m</button>
                  </div>
                </div>
                <br />
                {startErr && <div className="text-[11px] text-red-600 mt-1">{startErr}</div>}
              </label>

              <label className="block text-sm">
                <span className="font-medium">End (YYYY-MM-DDTHH:mm:ssZ)</span>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    className={`w-full border rounded-md px-2 py-1 font-mono text-xs ${endErr ? 'border-red-300' : ''}`}
                    placeholder="2025-08-22T10:30:00Z"
                    value={formEnd}
                    onChange={(e) => setFormEnd(e.target.value)}
                  />
                  <div className="flex gap-1">
                    <button onClick={() => nudge('end', -15)} className="px-2 py-1 rounded-md border text-xs">−15m</button>
                    <button onClick={() => nudge('end', +15)} className="px-2 py-1 rounded-md border text-xs">+15m</button>
                  </div>
                </div>
                <br />
                {endErr && <div className="text-[11px] text-red-600 mt-1">{endErr}</div>}
              </label>

              {intervalErr && (
                <div className="text-xs text-red-700 border border-red-200 bg-red-50 rounded-md px-2 py-1">{intervalErr}</div>
              )}

              {panelError && (
                <div className="text-xs text-red-700 border border-red-200 bg-red-50 rounded-md px-2 py-1">{panelError}</div>
              )}

              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-2">
                  <button onClick={clearHighlightAndPanel} className="px-3 py-2 rounded-xl border hover:bg-gray-50 text-sm" disabled={saving}>Cancel</button>
                  <button onClick={handleSave} className={`px-3 py-2 rounded-xl border text-sm ${canSave ? 'hover:bg-blue-50' : 'opacity-50 cursor-not-allowed'}`} disabled={!canSave}>{saving ? "Saving…" : "Save"}</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {!panelOpen && (
        <div className="mt-3 text-sm text-gray-500 text-center italic">Click a bar to edit (UTC)</div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-600 text-white text-sm px-3 py-2 rounded-xl shadow-lg">{toast}</div>
      )}

      <style jsx>{`
        :global(.vis-item .vis-item-content) { font-size: 12px; font-weight: 500; padding: 6px 8px; }
        .timeline-container[data-dim="true"] :global(.vis-item) { opacity: 0.25; filter: grayscale(0.2); }
        .timeline-container[data-dim="true"] :global(.vis-item.vis-selected) { opacity: 1 !important; filter: none !important; box-shadow: 0 0 0 2px rgba(59,130,246,0.6) inset; }
        :global(.vis-current-time) { width: 2px; background: #ef4444; z-index: 9999; }
        :global(.vis-item.vis-selected .vis-item-content) { background: inherit !important; }
        :global(.vis-custom-time .vis-custom-time-marker) { font-size: 11px; font-weight: 600; }
        :global(.vis-label .vis-inner) { font-weight: 600; }
      `}</style>
    </div>
  );
}