'use client';

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { topicColor } from '@/lib/colors';
import type { GraphLink, GraphNode } from '@/lib/dashboard';

type Node = GraphNode & SimulationNodeDatum & { color: string; r: number };
type Link = Omit<GraphLink, 'source' | 'target'> & { source: Node | string; target: Node | string };

function obsidian(vaultName: string | null, path: string | null) {
  if (!vaultName || !path) return null;
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path.replace(/\.md$/, ''))}`;
}

export default function Constellation({
  nodes: rawNodes,
  links: rawLinks,
  topicOrder,
  vaultName,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
  topicOrder: string[];
  vaultName: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ node: Node; x: number; y: number } | null>(null);

  const { nodes, links, neighbors } = useMemo(() => {
    const nodes: Node[] = rawNodes.map((n) => ({
      ...n,
      color: n.kind === 'source' ? '#7fd6e8' : topicColor(n.topic, topicOrder),
      r: n.kind === 'source' ? 3 : 3.2 + Math.sqrt(n.degree) * 2.4 + (n.status === 'evergreen' ? 1.2 : 0),
    }));
    const links: Link[] = rawLinks.map((l) => ({ ...l }));
    const neighbors = new Map<string, Set<string>>();
    for (const l of rawLinks) {
      if (!neighbors.has(l.source)) neighbors.set(l.source, new Set());
      if (!neighbors.has(l.target)) neighbors.set(l.target, new Set());
      neighbors.get(l.source)!.add(l.target);
      neighbors.get(l.target)!.add(l.source);
    }
    return { nodes, links, neighbors };
  }, [rawNodes, rawLinks, topicOrder]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !nodes.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = wrap.clientWidth;
    let height = canvas.clientHeight;
    let transform: ZoomTransform = zoomIdentity;
    let hovered: Node | null = null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // A fixed field of faint background stars
    const stars = Array.from({ length: 140 }, (_, i) => {
      const s = Math.sin(i * 12.9898) * 43758.5453;
      const t = Math.sin(i * 78.233) * 12345.6789;
      return { x: s - Math.floor(s), y: t - Math.floor(t), a: 0.15 + ((i * 7) % 10) / 40 };
    });

    const resize = () => {
      width = wrap.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    };
    resize();

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) {
        ctx.fillStyle = `rgba(238, 240, 251, ${s.a})`;
        ctx.fillRect(s.x * width, s.y * height, 1, 1);
      }

      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);
      const focus = hovered ? neighbors.get(hovered.id) ?? new Set<string>() : null;
      const lit = (id: string) => !focus || id === hovered!.id || focus.has(id);

      for (const l of links) {
        const a = l.source as Node;
        const b = l.target as Node;
        if (a.x == null || b.x == null) continue;
        const on = lit(a.id) && lit(b.id);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y!);
        ctx.lineTo(b.x, b.y!);
        ctx.setLineDash(l.kind === 'suggested' ? [3, 4] : []);
        if (l.kind === 'accepted') {
          ctx.strokeStyle = l.relation === 'contradicts' ? `rgba(255, 138, 122, ${on ? 0.85 : 0.15})` : `rgba(127, 214, 232, ${on ? 0.6 : 0.1})`;
          ctx.lineWidth = 1.3 / transform.k;
        } else if (l.kind === 'suggested') {
          ctx.strokeStyle = `rgba(169, 176, 214, ${on ? 0.4 : 0.08})`;
          ctx.lineWidth = 1 / transform.k;
        } else {
          ctx.strokeStyle = `rgba(169, 176, 214, ${on ? 0.16 : 0.05})`;
          ctx.lineWidth = 0.8 / transform.k;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const n of nodes) {
        if (n.x == null) continue;
        const alpha = lit(n.id) ? 1 : 0.25;
        ctx.globalAlpha = alpha;
        if (n.kind === 'source') {
          ctx.beginPath();
          ctx.arc(n.x, n.y!, n.r, 0, Math.PI * 2);
          ctx.strokeStyle = n.color;
          ctx.lineWidth = 1.2 / transform.k;
          ctx.stroke();
        } else {
          ctx.shadowColor = n.color;
          ctx.shadowBlur = (n.status === 'evergreen' ? 16 : 9) * alpha;
          ctx.beginPath();
          ctx.arc(n.x, n.y!, n.r, 0, Math.PI * 2);
          ctx.fillStyle = n.color;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
      ctx.globalAlpha = 1;

      // Labels: most connected ideas first, skipped where they would overlap
      const narrow = width < 640;
      const maxLabels = hovered ? 12 : transform.k > 1.4 ? 24 : narrow ? 0 : 8;
      const candidates = nodes
        .filter((n) => n.kind === 'idea' && n.x != null && lit(n.id) && (n.degree > 0 || transform.k > 1.4 || n === hovered))
        .sort((a, b) => (a === hovered ? -1 : b === hovered ? 1 : b.degree - a.degree));
      ctx.font = `${13 / transform.k}px Newsreader, Georgia, serif`;
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      const h = 16 / transform.k;
      let shown = 0;
      for (const n of candidates) {
        if (shown >= maxLabels && n !== hovered) break;
        const text = n.label.length > 40 ? `${n.label.slice(0, 39)}…` : n.label;
        const w = ctx.measureText(text).width;
        const box = { x: n.x! + n.r + 5 / transform.k, y: n.y! - h / 2, w, h };
        const clash =
          placed.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y) ||
          nodes.some((m) => m !== n && m.x != null && m.x > box.x && m.x < box.x + box.w && Math.abs(m.y! - n.y!) < h * 0.7);
        if (clash && n !== hovered) continue;
        ctx.fillStyle = 'rgba(10, 15, 40, 0.72)';
        ctx.fillRect(box.x - 3 / transform.k, box.y, box.w + 6 / transform.k, box.h);
        ctx.fillStyle = n === hovered ? '#eef0fb' : 'rgba(238, 240, 251, 0.82)';
        ctx.fillText(text, box.x, n.y! + 4.5 / transform.k);
        placed.push(box);
        shown++;
      }
      ctx.restore();
    };

    let userMoved = false;
    const zoomer = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 5])
      .on('zoom', (event) => {
        transform = event.transform;
        if (event.sourceEvent) userMoved = true;
        draw();
      });
    const selection = select(canvas);
    selection.call(zoomer);

    /** Keeps every star in view while the map settles. */
    const fit = () => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        if (n.x == null) continue;
        minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
        minY = Math.min(minY, n.y! - n.r); maxY = Math.max(maxY, n.y! + n.r);
      }
      if (!Number.isFinite(minX)) return;
      const padX = width < 640 ? 28 : 70;
      const top = 76;
      const bottom = 24;
      const k = Math.max(0.2, Math.min((width - padX * 2) / Math.max(maxX - minX, 1), (height - top - bottom) / Math.max(maxY - minY, 1), 2.4));
      const tx = (width - (maxX + minX) * k) / 2;
      const ty = top + (height - top - bottom - (maxY - minY) * k) / 2 - minY * k;
      selection.call(zoomer.transform, zoomIdentity.translate(tx, ty).scale(k));
    };

    const sim = forceSimulation<Node>(nodes)
      .force(
        'link',
        forceLink<Node, Link>(links as never)
          .id((d) => d.id)
          .distance((l) => ((l as Link).kind === 'from' ? 46 : (l as Link).kind === 'accepted' ? 95 : 120))
          .strength((l) => ((l as Link).kind === 'suggested' ? 0.04 : (l as Link).kind === 'from' ? 0.5 : 0.35)),
      )
      .force('charge', forceManyBody<Node>().strength((d) => (d.kind === 'source' ? -30 : -120)))
      .force('center', forceCenter(width / 2, height / 2))
      .force('x', forceX<Node>(width / 2).strength(0.02))
      .force('y', forceY<Node>(height / 2).strength(0.035))
      .force('collide', forceCollide<Node>().radius((d) => d.r + 6));

    if (reduced) {
      sim.stop();
      for (let i = 0; i < 300; i++) sim.tick();
      fit();
    } else {
      sim.alphaDecay(0.03).on('tick', () => {
        if (!userMoved) fit();
        else draw();
      });
    }

    const findNode = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const [x, y] = transform.invert([clientX - rect.left, clientY - rect.top]);
      let best: Node | null = null;
      let bestDist = 14 / transform.k;
      for (const n of nodes) {
        if (n.x == null) continue;
        const d = Math.hypot(n.x - x, n.y! - y) - n.r;
        if (d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
      return { node: best, x: clientX - rect.left, y: clientY - rect.top };
    };

    const onMove = (e: PointerEvent) => {
      const { node, x, y } = findNode(e.clientX, e.clientY);
      if (node !== hovered) {
        hovered = node;
        draw();
      }
      setHover(node ? { node, x, y } : null);
      canvas.style.cursor = node ? 'pointer' : '';
    };
    const onLeave = () => {
      hovered = null;
      setHover(null);
      draw();
    };
    const onClick = (e: MouseEvent) => {
      const { node } = findNode(e.clientX, e.clientY);
      const url = node ? obsidian(vaultName, node.path) : null;
      if (url) window.location.href = url;
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('click', onClick);
    const ro = new ResizeObserver(() => {
      resize();
      if (!userMoved) fit();
      else draw();
    });
    ro.observe(wrap);

    return () => {
      sim.stop();
      ro.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      select(canvas).on('.zoom', null);
    };
  }, [nodes, links, neighbors, vaultName]);

  const ideaCount = rawNodes.filter((n) => n.kind === 'idea').length;
  const accepted = rawLinks.filter((l) => l.kind === 'accepted').length;

  return (
    <div className="sky" ref={wrapRef}>
      <canvas ref={canvasRef} aria-label={`Map of ${ideaCount} ideas and ${accepted} connections`} role="img" />
      <div className="sky-title">
        Your ideas
        <span>
          {ideaCount} {ideaCount === 1 ? 'idea' : 'ideas'}, {accepted} {accepted === 1 ? 'connection' : 'connections'}. Zoom and drag to explore.
        </span>
      </div>
      {!ideaCount && (
        <div className="sky-empty">
          <div>
            <p>Your sky fills in as you write ideas in your own words.</p>
            <span>
              Send <code className="cmd">/idea</code> to your bot, or add a note in 01 Ideas.
            </span>
          </div>
        </div>
      )}
      {ideaCount > 0 && (
        <div className="legend" aria-hidden="true">
          <span><i className="dot" />Idea</span>
          <span><i className="ring" />Source</span>
          <span><i className="ln" />Connection</span>
          <span><i className="ln tension" />Tension</span>
          <span><i className="ln dash" />Suggested</span>
        </div>
      )}
      {hover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          {hover.node.label}
          <small>
            {hover.node.kind === 'source'
              ? `Source${hover.node.format ? `, ${hover.node.format}` : ''}`
              : `${hover.node.topic ?? 'No topic'}${hover.node.degree ? `, ${hover.node.degree} connection${hover.node.degree === 1 ? '' : 's'}` : ''}${hover.node.status === 'evergreen' ? ', evergreen' : ''}`}
            {vaultName && hover.node.path ? '. Click to open in Obsidian' : ''}
          </small>
        </div>
      )}
    </div>
  );
}
