// React context exposing the live MatrixTransport down the tree.  Lets
// any component hit transport.getMxcBlobUrl(...), transport.flag(...),
// etc. without prop-drilling.

import { createContext, useContext } from "react";
import type { MatrixTransport } from "@/lib/matrix";

export const TransportContext = createContext<MatrixTransport | null>(null);

export function useTransport(): MatrixTransport | null {
	return useContext(TransportContext);
}
