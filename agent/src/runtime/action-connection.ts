import type http from "node:http";

// IncomingMessage.close also fires after a complete request body. The response
// close event identifies a disconnected caller while waiting for the lock.
export function actionConnection(request: http.IncomingMessage, response: http.ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  if (request.aborted || response.destroyed) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  };
}
