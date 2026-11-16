"use client";
// For the Lab's skeleton as the server sends it: before the first paint, a target in the address
// gives the blink player and the analysis pane a field's shape, and the panes the visitor hid or
// resized (Settings, Ctrl B / Ctrl J / Ctrl Alt B, the resize handles) are hidden or resized as the
// workbench will show them. Rendered on the server only (and kept while hydrating): a script that
// React creates on the client would never run.

import { useSyncExternalStore } from "react";
import { PREFS_STORAGE_KEY, PREFS_VERSION } from "@/lib/preferences-schema";

const SCRIPT = `(function(){try{var r=document.currentScript&&document.currentScript.parentElement;if(!r)return;if(/[?&]target=/.test(location.search))r.setAttribute("data-field","target");var s=JSON.parse(localStorage.getItem(${JSON.stringify(
  PREFS_STORAGE_KEY,
)})||"null"),p=s&&s.v===${PREFS_VERSION}&&s.prefs||{};if(p.labDataPane===false)r.setAttribute("data-data","off");if(p.labBlinkPlayer===false)r.setAttribute("data-player","off");if(p.labAnalysisPane===false)r.setAttribute("data-analysis","off");var w=function(k,lo,hi,v){var n=Number(localStorage.getItem(k));if(isFinite(n)&&n>0)r.style.setProperty(v,Math.round(Math.min(hi,Math.max(lo,n)))+"px")};w("pxh-lab-left",236,420,"--lab-l");w("pxh-lab-right",320,560,"--lab-r")}catch(e){}})();`;

const noopSubscribe = () => () => {};

export function LabSkeletonScript() {
  const onServer = useSyncExternalStore(
    noopSubscribe,
    () => false,
    () => true,
  );
  return onServer ? <script dangerouslySetInnerHTML={{ __html: SCRIPT }} /> : null;
}
