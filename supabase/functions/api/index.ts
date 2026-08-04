// Точка запуска Supabase Edge Function. Серверная логика разнесена по Deno-модулям.
import { handleRequest } from "./http.ts";

Deno.serve(handleRequest);
