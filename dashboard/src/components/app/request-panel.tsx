import { lazy, Suspense } from "react";
import { Loader2, Send } from "lucide-react";
import type { AppResponse, HttpMethod } from "@/api";
import { cn } from "@/lib/utils";

const CodeEditor = lazy(() => import("./code-editor"));

export const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface AppRequest {
  method: HttpMethod;
  path: string;
  body: string;
}

function pretty(response: AppResponse): { text: string; json: boolean } {
  if (response.contentType?.includes("json")) {
    try {
      return { text: JSON.stringify(JSON.parse(response.body), null, 2), json: true };
    } catch {
      // Fall through and show it as sent.
    }
  }
  return { text: response.body, json: false };
}

const statusColor = (status: number) =>
  status === 0 ? "text-rose-400" : status < 300 ? "text-emerald-400" : status < 400 ? "text-sky-300" : status < 500 ? "text-amber-300" : "text-rose-400";

// A tiny REST client in the bottom panel. Requests go through NightShift's proxy, so they
// show up in the app's metrics like real users.
export function RequestPanel({
  request,
  response,
  sending,
  routes,
  onChange,
  onSend,
}: {
  request: AppRequest;
  response: (AppResponse & { method: HttpMethod; path: string }) | null;
  sending: boolean;
  routes: string[];
  onChange: (next: AppRequest) => void;
  onSend: () => void;
}) {
  const hasBody = request.method !== "GET" && request.method !== "DELETE";
  const shown = response ? pretty(response) : null;
  return (
    <div className="flex h-full flex-col">
      <form
        className="flex shrink-0 items-center gap-1.5 px-3 py-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <select
          value={request.method}
          onChange={(event) => onChange({ ...request, method: event.target.value as HttpMethod })}
          className="h-7 border border-[#3c3c3c] bg-[#313131] px-1.5 font-mono text-[12px] text-zinc-100 outline-none"
        >
          {METHODS.map((method) => (
            <option key={method}>{method}</option>
          ))}
        </select>
        <input
          value={request.path}
          onChange={(event) => onChange({ ...request, path: event.target.value })}
          list="app-routes"
          placeholder="/path"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 border border-[#3c3c3c] bg-[#313131] px-2 font-mono text-[12px] text-zinc-100 outline-none focus:border-[#007fd4]"
        />
        <datalist id="app-routes">
          {routes.map((route) => (
            <option key={route} value={route} />
          ))}
        </datalist>
        <button
          type="submit"
          disabled={sending || !request.path.startsWith("/")}
          className="flex h-7 items-center gap-1.5 rounded-sm bg-[#0078d4] px-3 text-[12px] text-white hover:bg-[#026ec1] disabled:opacity-50"
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Send
        </button>
      </form>
      {hasBody && (
        <textarea
          value={request.body}
          onChange={(event) => onChange({ ...request, body: event.target.value })}
          placeholder='JSON body, e.g. {"name": "test"}'
          spellCheck={false}
          className="mx-3 mb-1.5 h-16 shrink-0 resize-none border border-[#3c3c3c] bg-[#313131] px-2 py-1 font-mono text-[12px] text-zinc-100 outline-none focus:border-[#007fd4]"
        />
      )}
      {response && shown ? (
        <>
          <div className="flex shrink-0 items-center gap-3 border-t border-[#2b2b2b] px-3 py-1 font-mono text-[11.5px] text-zinc-400">
            <span className={cn("font-semibold", statusColor(response.status))}>{response.status === 0 ? "no response" : response.status}</span>
            <span>{response.ms} ms</span>
            <span className="truncate">
              {response.method} {response.path}
            </span>
            {response.contentType && <span className="ml-auto truncate">{response.contentType}</span>}
          </div>
          <div className="min-h-0 flex-1">
            <Suspense fallback={null}>
              <CodeEditor path={shown.json ? "__response__.json" : "__response__.txt"} content={shown.text} />
            </Suspense>
          </div>
        </>
      ) : (
        <p className="px-3 py-2 text-xs text-zinc-500">
          Send a request to your app. It goes through NightShift's proxy, so it counts toward the app's live metrics.
        </p>
      )}
    </div>
  );
}
