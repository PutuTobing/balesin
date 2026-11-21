import { AppError } from '@balesin/core';
import { organizations, type Database } from '@balesin/db';
import { API_DOCS_ROUTES } from '@balesin/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PUBLIC } from '../../http/route-access';
import { findInstallationOrganization } from '../installation/installation.repo';
import { buildOpenApiDocument } from './openapi';

export interface ApiDocsRoutesOptions {
  db: Database;
  /** URL publik API (server di dokumen OpenAPI). */
  apiUrl: string;
}

/**
 * Dokumentasi API publik (Fase 3): `/api/docs` (halaman), `/api/docs/app.js` (skrip penampil, tanpa
 * CDN), `/api/docs/openapi.json` (OpenAPI 3.1). Publik (tanpa sesi) tetapi bisa DIMATIKAN lewat
 * Pengaturan → API (`organizations.api_docs_enabled`) → 404. Tidak memuat data organisasi/rahasia.
 * CSP halaman: skrip & sambungan hanya ke origin sendiri, tanpa skrip/gaya inline.
 */

const PAGE_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PAGE = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dokumentasi API</title>
<link rel="stylesheet" href="${API_DOCS_ROUTES.style}">
</head>
<body>
<main id="docs"><p>Memuat dokumentasi…</p></main>
<script src="${API_DOCS_ROUTES.script}"></script>
</body>
</html>
`;

const STYLE = `*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#14202E;background:#F6F4EF}
main{max-width:960px;margin:0 auto;padding:24px 16px}h1{font-size:24px;margin:0 0 8px}h2{font-size:16px;margin:24px 0 8px}
.op{background:#fff;border:1px solid #E2DED5;border-radius:10px;padding:12px 16px;margin:8px 0}
.method{display:inline-block;min-width:64px;font-weight:700;text-transform:uppercase}
code,pre{font-family:ui-monospace,monospace;font-size:13px}pre{background:#EFECE5;padding:8px;border-radius:6px;overflow:auto;max-height:320px}
.scope{color:#4A5869}details{margin-top:8px}
@media (prefers-color-scheme:dark){body{background:#0F1620;color:#E8EDF3}.op{background:#16202C;border-color:#263345}pre{background:#1C2735}.scope{color:#9FB0C3}}`;

/** Penampil sederhana: membaca openapi.json lalu membuat daftar endpoint (textContent, tanpa HTML). */
const SCRIPT = `(function(){
var root=document.getElementById('docs');
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
fetch('${API_DOCS_ROUTES.openapi}',{credentials:'omit'}).then(function(r){if(!r.ok)throw new Error('gagal');return r.json();}).then(function(doc){
root.textContent='';
root.appendChild(el('h1',null,doc.info.title+' '+doc.info.version));
root.appendChild(el('p',null,doc.info.description));
root.appendChild(el('p',null,'Server: '+(doc.servers&&doc.servers[0]?doc.servers[0].url:'')));
root.appendChild(el('p','scope',(doc.components.securitySchemes.apiKey.description||'')));
var a=el('a',null,'Unduh OpenAPI (JSON)');a.href='${API_DOCS_ROUTES.openapi}';root.appendChild(a);
Object.keys(doc.paths).forEach(function(path){Object.keys(doc.paths[path]).forEach(function(method){
var op=doc.paths[path][method];var box=el('section','op');
var head=el('div');head.appendChild(el('span','method',method));head.appendChild(el('code',null,path));box.appendChild(head);
box.appendChild(el('h2',null,op.summary));if(op.description)box.appendChild(el('p',null,op.description));
box.appendChild(el('p','scope','Scope: '+op['x-balesin-scope']));
function detail(label,value){if(!value)return;var d=el('details');d.appendChild(el('summary',null,label));d.appendChild(el('pre',null,JSON.stringify(value,null,2)));box.appendChild(d);}
detail('Parameter',op.parameters&&op.parameters.length?op.parameters:null);
detail('Body',op.requestBody?op.requestBody.content:null);
detail('Respons',op.responses);
root.appendChild(box);});});
}).catch(function(){root.textContent='Dokumentasi tidak bisa dimuat.';});
})();
`;

export const apiDocsRoutes: FastifyPluginCallbackZod<ApiDocsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { db } = options;
  const document = JSON.stringify(buildOpenApiDocument(`${options.apiUrl.replace(/\/$/, '')}`));

  async function ensureEnabled() {
    const organization = await findInstallationOrganization(db);
    if (!organization) throw new AppError('NOT_FOUND');
    const [row] = await db
      .select({ enabled: organizations.apiDocsEnabled })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    if (!row?.enabled) {
      throw new AppError('NOT_FOUND', { message: 'Dokumentasi API dimatikan oleh admin.' });
    }
  }

  const statics: [string, string, string, boolean][] = [
    [API_DOCS_ROUTES.page, 'text/html; charset=utf-8', PAGE, true],
    [`${API_DOCS_ROUTES.style}`, 'text/css; charset=utf-8', STYLE, false],
    [API_DOCS_ROUTES.script, 'text/javascript; charset=utf-8', SCRIPT, false],
    [API_DOCS_ROUTES.openapi, 'application/json; charset=utf-8', document, false],
  ];
  for (const [url, type, body, page] of statics) {
    app.get(url, { config: { access: PUBLIC, rawResponse: true } }, async (_request, reply) => {
      await ensureEnabled();
      void reply.header('content-type', type).header('cache-control', 'no-cache');
      if (page) void reply.header('content-security-policy', PAGE_CSP);
      return reply.send(body);
    });
  }

  done();
};
