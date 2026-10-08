import { createContext, useContext } from "react";
export const FileSourceContext = createContext<string | undefined>(undefined);
export function useFileSource(): string | undefined { return useContext(FileSourceContext); }
