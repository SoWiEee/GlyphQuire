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
