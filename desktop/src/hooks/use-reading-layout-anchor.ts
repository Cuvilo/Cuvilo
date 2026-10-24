import { useEffect, useRef, type RefObject } from "react";

// Width changes rewrap text. Hold the visible paragraph while the index slides away.
export function useReadingLayoutAnchor(root:RefObject<HTMLElement|null>) {
  const cancel=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>cancel.current?.(),[]);
  return (change:()=>void)=>{
    cancel.current?.();
    const viewport=root.current?.querySelector<HTMLElement>('.review-tab-content[data-state="active"] .review-reading-scroll');
    const top=viewport?.getBoundingClientRect().top??0;
    const anchor=viewport&&[...viewport.querySelectorAll<HTMLElement>('.review-question-heading,.answer-markdown > *,.transcript-row')].find(el=>el.getBoundingClientRect().bottom>top+2);
    const offset=anchor?anchor.getBoundingClientRect().top-top:0;
    change();
    if(!viewport||!anchor)return;
    let frame=0,stopped=false;const started=performance.now();
    const duration=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:340;
    const stop=()=>{if(stopped)return;stopped=true;cancelAnimationFrame(frame);viewport.removeEventListener('wheel',stop);viewport.removeEventListener('touchstart',stop);viewport.removeEventListener('keydown',onKey);cancel.current=null;};
    const onKey=(e:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key))stop();};
    const restore=()=>{if(!anchor.isConnected||!viewport.isConnected||!viewport.getClientRects().length){stop();return;}viewport.scrollTop+=anchor.getBoundingClientRect().top-viewport.getBoundingClientRect().top-offset;if(performance.now()-started<duration)frame=requestAnimationFrame(restore);else stop();};
    viewport.addEventListener('wheel',stop,{passive:true});viewport.addEventListener('touchstart',stop,{passive:true});viewport.addEventListener('keydown',onKey);
    cancel.current=stop;frame=requestAnimationFrame(restore);
  };
}
