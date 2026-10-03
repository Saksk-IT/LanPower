// Do not collect diagnostics, send mail or install third-party fetch listeners.
export function useFeedbackDiagnostics() {
  return { recordVisibleFailure: (_message: string) => {}, buildFeedbackMailto: () => '/activity', feedbackMailtoBase: () => '/activity' }
}
