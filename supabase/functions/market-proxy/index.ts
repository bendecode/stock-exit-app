const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const sources: Record<string, string> = {
  "tpex-mainboard": "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
  "tpex-emerging": "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const source = new URL(request.url).searchParams.get("source") || "";
  const targetUrl = sources[source];
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Unknown market data source" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "stock-exit-app/1.0",
      },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Market data source unavailable" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  }
});
