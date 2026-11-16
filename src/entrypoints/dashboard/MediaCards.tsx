import { useEffect, useState } from 'react';
import { listCaptures } from '@/lib/db';
import { readExif, type ExifResult } from '@/lib/exif';
import { capturePath, readFile } from '@/lib/opfs';
import type { CaptureFile, CaptureRecord } from '@/lib/types';
import { captureLabel, LocalTime } from '@/ui/components';
import { useLive } from '@/ui/hooks';

type Meta = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };

/** The primary file: image, video or audio, with the element marked on in-context screenshots. */
export function MediaPreview({ c, primary, url }: { c: CaptureRecord; primary: CaptureFile | undefined; url: string | null }) {
  if (!url || !primary) return <p className="muted">No preview.</p>;
  const meta = c.meta as Meta;
  if (primary.mime.startsWith('video/')) {
    return <video className="viewer-video" src={url} controls preload="metadata" aria-label={`Captured video from ${c.url}`} />;
  }
  if (primary.mime.startsWith('audio/')) return <audio src={url} controls style={{ width: '100%' }} />;
  if (!primary.mime.startsWith('image/')) return <p className="muted">No preview for {primary.mime}.</p>;
  const rect = meta.elementRectCss as Rect | null | undefined;
  const vp = meta.viewport as { width: number; height: number } | undefined;
  const mark = meta.mode === 'context' && rect && vp && !meta.elementInFrame;
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Open full size" className="viewer-frame">
      <img className="viewer-img" src={url} alt={`Capture of ${c.url}`} style={{ display: 'block' }} />
      {mark && (
        <span
          className="mark"
          aria-hidden
          style={{
            left: `${(Math.max(0, rect.x) / vp.width) * 100}%`,
            top: `${(Math.max(0, rect.y) / vp.height) * 100}%`,
            width: `${(Math.min(rect.width, vp.width) / vp.width) * 100}%`,
            height: `${(Math.min(rect.height, vp.height) / vp.height) * 100}%`,
          }}
        />
      )}
    </a>
  );
}

/** EXIF, read from the stored file for display only (SPEC F6 step 3). */
export function ExifCard({ c, primary }: { c: CaptureRecord; primary: CaptureFile | undefined }) {
  const [exif, setExif] = useState<ExifResult | null>(null);
  useEffect(() => {
    if (!primary?.mime.startsWith('image/') || c.type !== 'image') return;
    readFile(capturePath(c.caseId, c.id, primary.path))
      .then(async (f) => setExif(readExif(new Uint8Array(await f.arrayBuffer()))))
      .catch(() => setExif(null));
  }, [c.id, primary?.path]);
  if (c.type !== 'image') return null;
  const tags = exif ? Object.entries(exif.tags) : [];
  return (
    <div className="card">
      <h2>Embedded metadata (EXIF)</h2>
      {!exif ? (
        <p className="muted small">Reading…</p>
      ) : tags.length === 0 && !exif.gps ? (
        <p className="muted small">
          No EXIF data in this {exif.format.toUpperCase()} file.
          {c.degraded.some((d) => d.startsWith('re-encoded')) && ' It was re-encoded, so any original metadata was lost.'}
          {exif.hasXmp && ' It contains an XMP block.'}
          {exif.hasIptc && ' It contains IPTC data.'}
        </p>
      ) : (
        <>
          <dl className="kv">
            {exif.gps && (
              <>
                <dt>GPS position</dt>
                <dd className="mono">
                  {exif.gps.latitude}, {exif.gps.longitude}
                  {exif.gps.altitude !== undefined && ` · ${exif.gps.altitude} m`}
                </dd>
              </>
            )}
            {tags.map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd className="mono">{String(v)}</dd>
              </span>
            ))}
          </dl>
          <p className="small muted">
            Read-only. Shown as stored in the file; the file itself is unchanged.
            {exif.hasXmp && ' The file also contains an XMP block.'}
            {exif.hasIptc && ' The file also contains IPTC data.'}
          </p>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Where an image or video came from (SPEC F6 step 4, F7). */
export function SourceCard({ c }: { c: CaptureRecord }) {
  const m = c.meta as Meta;
  if (c.type !== 'image' && c.type !== 'video') return null;
  const el = (m.element ?? {}) as Meta;
  const dims = (d: unknown) => {
    const x = d as { width: number; height: number } | null | undefined;
    return x && x.width ? `${x.width} × ${x.height}` : null;
  };
  const retrieval = m.retrieval as { method: string; failedAttempts: { method: string; error: string }[] } | undefined;
  const v = m.video as Meta | null | undefined;
  const urls = m.urlsDuringRecording as { url: string; atUtc: string }[] | undefined;
  const headers = m.responseHeaders as Record<string, string> | null | undefined;
  return (
    <div className="card">
      <h2>{c.method.startsWith('tabCapture') ? 'Tab recording' : 'Source'}</h2>
      <dl className="kv">
        <Row label="Media address">{m.sourceUrl ? <span className="mono" style={{ wordBreak: 'break-all' }}>{String(m.sourceUrl)}</span> : null}</Row>
        <Row label="Final address">
          {m.finalUrl && m.finalUrl !== m.sourceUrl ? <span className="mono" style={{ wordBreak: 'break-all' }}>{String(m.finalUrl)}</span> : null}
        </Row>
        <Row label="Page">{m.pageUrl ? <span className="mono" style={{ wordBreak: 'break-all' }}>{String(m.pageUrl)}</span> : null}</Row>
        <Row label="In frame">{m.frameUrl ? <span className="mono">{String(m.frameUrl)}</span> : null}</Row>
        <Row label="Retrieved by">{retrieval ? <span className="mono">{retrieval.method}</span> : null}</Row>
        <Row label="Source chosen">{m.sourceChoice ? String(m.sourceChoice) : null}</Row>
        <Row label="HTTP status">{m.httpStatus ? String(m.httpStatus) : null}</Row>
        <Row label="Type">{m.mime ? <span className="mono">{String(m.mime)}</span> : null}</Row>
        <Row label="Natural size">{dims(el.natural)}</Row>
        <Row label="Shown at">{dims(el.rendered) ? `${dims(el.rendered)} CSS px` : null}</Row>
        <Row label="Alt text">{el.alt ? String(el.alt) : null}</Row>
        <Row label="Title">{el.title ? String(el.title) : null}</Row>
        <Row label="Duration">{v?.duration ? `${Math.round(Number(v.duration))} s` : null}</Row>
        <Row label="Recorded">
          {m.durationMs ? `${Math.round(Number(m.durationMs) / 1000)} s` : null}
        </Row>
        <Row label="Video size">{dims(m.videoSize)}</Row>
        <Row label="Stopped because">{m.stopReason ? String(m.stopReason) : null}</Row>
        <Row label="DRM">{m.drm ? 'Yes: protected media may record as black frames' : null}</Row>
        <Row label="Resumed at">
          {Array.isArray(m.resumedAt) && m.resumedAt.length ? (m.resumedAt as number[]).map((n) => `byte ${n}`).join(', ') : null}
        </Row>
      </dl>
      {urls && urls.length > 0 && (
        <>
          <h3 className="small" style={{ margin: '10px 0 4px' }}>
            Addresses shown during the recording
          </h3>
          <ol className="small mono" style={{ margin: 0, paddingLeft: 18 }}>
            {urls.map((u, i) => (
              <li key={i} style={{ wordBreak: 'break-all' }}>
                <LocalTime utc={u.atUtc} /> {u.url}
              </li>
            ))}
          </ol>
        </>
      )}
      {typeof m.snippet === 'string' && m.snippet && (
        <p className="small" style={{ marginBottom: 0 }}>
          <span className="muted">Nearby text:</span> “{m.snippet}”
        </p>
      )}
      {retrieval && retrieval.failedAttempts.length > 0 && (
        <details className="small">
          <summary>Earlier attempts that failed ({retrieval.failedAttempts.length})</summary>
          <ul className="mono">
            {retrieval.failedAttempts.map((a, i) => (
              <li key={i}>
                {a.method}: {a.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      {headers && Object.keys(headers).length > 0 && (
        <details className="small">
          <summary>Response headers</summary>
          <dl className="kv mono">
            {Object.entries(headers).map(([k, val]) => (
              <span key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd style={{ wordBreak: 'break-all' }}>{val}</dd>
              </span>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

/** The parent artefact and any children (such as the in-context screenshot). */
export function RelatedCard({ c }: { c: CaptureRecord }) {
  const [all] = useLive(() => listCaptures(c.caseId), ['captures'], [c.caseId]);
  if (!all) return null;
  const parent = c.parent ? all.find((x) => x.id === c.parent) : null;
  const children = all.filter((x) => x.parent === c.id);
  if (!parent && children.length === 0) return null;
  return (
    <div className="card">
      <h2>Related</h2>
      <ul className="list">
        {parent && (
          <li>
            <a href={`#/case/${c.caseId}/capture/${parent.id}`}>
              Part of: {captureLabel(parent)} · <LocalTime utc={parent.startedAtUtc} />
            </a>
          </li>
        )}
        {children.map((ch) => (
          <li key={ch.id}>
            <a href={`#/case/${c.caseId}/capture/${ch.id}`}>
              {captureLabel(ch)} · <LocalTime utc={ch.startedAtUtc} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
