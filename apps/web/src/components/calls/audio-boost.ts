/** Browser adapter for FR-CALL-008. The limiter follows gain to tame loud peaks. */
export function createCallAudioBoost(context: BaseAudioContext, gain: number) {
  const boost = context.createGain();
  boost.gain.value = gain;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  return { boost, limiter, nodes: [boost, limiter] };
}
