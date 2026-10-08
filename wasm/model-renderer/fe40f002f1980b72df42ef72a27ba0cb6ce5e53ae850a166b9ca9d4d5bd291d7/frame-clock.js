// All views share one animation callback. Busy, hidden, and paused views leave
// the set; a response or input schedules them again.
const pending=new Set();
let raf=0;
export function scheduleFrame(view) {
  pending.add(view);
  if(!raf)raf=requestAnimationFrame(now=>{
    raf=0;
    const current=Array.from(pending);pending.clear();
    for(const item of current)item._tick(now);
  });
}
export function cancelFrame(view) {
  pending.delete(view);
  if(!pending.size&&raf){cancelAnimationFrame(raf);raf=0;}
}
