import { noteApiContract } from "./notes/schemas.js";
import type {
  ApiClient,
  ApiClientTransport,
  NoteEndpointInput,
  NoteEndpointName,
  NoteEndpointOutput,
} from "./notes/types.js";

export * from "./notes/errors.js";
export * from "./notes/schemas.js";
export * from "./notes/types.js";
export * from "./themes/schemas.js";
export * from "./themes/types.js";
export * from "./jobs/schemas.js";
export * from "./jobs/types.js";
export * from "./me/schemas.js";
export * from "./assets/schemas.js";
export * from "./assets/types.js";
export * from "./search/schemas.js";
export * from "./search/types.js";
export * from "./transfer/schemas.js";
export * from "./transfer/types.js";
export * from "./share-links/schemas.js";
export * from "./share-links/types.js";
export * from "./maintenance/schemas.js";
export * from "./maintenance/types.js";
export * from "./preferences/index.js";
export * from "./custom-blocks/index.js";

// The public cursor contract is the canonical encoded job cursor. Note pages
// continue to expose their transport cursor schema from `notes/schemas.js`.
export { cursorSchema } from "./jobs/schemas.js";

export function createApiClient(transport: ApiClientTransport): ApiClient {
  return {
    contract: noteApiContract,
    async request<TName extends NoteEndpointName>(
      endpoint: TName,
      input: NoteEndpointInput<TName>,
    ): Promise<NoteEndpointOutput<TName>> {
      const endpointContract = noteApiContract[endpoint];
      const validatedInput = endpointContract.request.parse(input);
      const response = await transport.request(endpoint, validatedInput);

      return endpointContract.response.parse(response) as NoteEndpointOutput<TName>;
    },
  };
}
