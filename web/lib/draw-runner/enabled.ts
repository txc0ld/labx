/** True when LABx closes sales, counts entries, starts the draw and finishes raffles on a schedule. Off unless the flag is exactly "1". */
export function drawRunnerEnabled(flag: string | undefined = process.env.NEXT_PUBLIC_LABX_DRAW_RUNNER): boolean {
  return flag === "1";
}
