import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UseGenerationResult<T> {
  loading: boolean;
  result: T | null;
  error: string | null;
  generate: (cmd: string, args: Record<string, unknown>) => Promise<void>;
  reset: () => void;
}

export function useGeneration<T = unknown>(): UseGenerationResult<T> {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async (cmd: string, args: Record<string, unknown>) => {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<T>(cmd, args);
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setResult(null);
    setError(null);
    setLoading(false);
  };

  return { loading, result, error, generate, reset };
}
