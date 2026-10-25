"use strict";

/* ==========================================================
   1. CONFIGURATION
   ========================================================== */

const CONFIG = {
  stationId: "NSR:StopPlace:58281",

  latitude: 59.917,
  longitude: 10.587,
  timeZone: "Europe/Oslo",

  transportRefreshMs: 30_000,
  weatherRefreshMs: 600_000,
  staleAfterMs: 120_000,

  walkMinutes: 8,
  yellowMinutes: 10,
  tooLateMinutes: 7,
  tooLateSeconds: 30,

  blueFillWindowMinutes: 15
};

const routes = [
  {
    line: "150",
    destination: "Gullhaug",
    match: "Gullhaug",
    mode: "bus",
    icon: "🚌"
  },
  {
    line: "150",
    destination: "Nationaltheateret",
    match: "Nationaltheatret",
    mode: "bus",
    icon: "🚌"
  },
  {
    line: "3",
    destination: "Mortensrud",
    match: "Mortensrud",
    mode: "metro",
    icon: "🚇"
  }
];


/* ==========================================================
   2. APPLICATION STATE AND HELPERS
   ========================================================== */

const HOUR = 3_600_000;

const lists = routes.map(() => []);

let updated = 0;
let busy = false;

let weatherBusy = false;
let weatherUpdated = 0;

let chart = null;
let installPrompt = null;

const $ = id => document.getElementById(id);

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: CONFIG.timeZone
});

const time = value => {
  return timeFormatter.format(new Date(value));
};

const norm = value => {
  return String(value || "")
    .toLowerCase()
    .replaceAll("nationaltheateret", "nationaltheatret")
    .trim();
};


/* ==========================================================
   3. CREATE THE TRANSPORT TICKETS
   ========================================================== */

routes.forEach((route, index) => {
  const card = document.createElement("article");

  card.className = "ticket";
  card.id = `ticket-${index}`;

  card.innerHTML = `
    <div class="fill"></div>

    <div class="ticket-main">
      <div class="route">
        <span class="icon" aria-hidden="true">
          ${route.icon}
        </span>

        <span class="badge line-${route.line}">
          ${route.line}
        </span>

        <h3 class="destination">
          ${route.destination}
        </h3>
      </div>

      <div class="departure">--:--</div>
      <div class="status"></div>
    </div>

    <div class="ticket-footer">
      <span class="next-label">
        Next ${route.mode} at
      </span>

      <span class="next-time">--:--</span>
    </div>
  `;

  $("tickets").append(card);
});


/* ==========================================================
   4. CLOCK
   ========================================================== */

function clock() {
  const now = new Date();

  $("clock").textContent = time(now);

  $("date").textContent = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: CONFIG.timeZone
  });
}


/* ==========================================================
   5. NETWORK REQUEST HELPER
   ========================================================== */

async function json(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 20_000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}


/* ==========================================================
   6. FETCH TRANSPORT DATA FROM ENTUR
   API responses are not cached by the service worker.
   ========================================================== */

async function transport() {
  if (busy) return;

  busy = true;

  try {
    const query = `
      query Departures($id: String!) {
        stopPlace(id: $id) {
          estimatedCalls(
            timeRange: 14400
            numberOfDepartures: 200
          ) {
            expectedDepartureTime
            realtime
            cancellation

            destinationDisplay {
              frontText
            }

            serviceJourney {
              line {
                publicCode
                transportMode
              }
            }
          }
        }
      }
    `;

    const data = await json(
      "https://api.entur.io/journey-planner/v3/graphql",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "ET-Client-Name": "home-bekkestua-browser-dashboard"
        },

        body: JSON.stringify({
          query,
          variables: {
            id: CONFIG.stationId
          }
        })
      }
    );

    if (data.errors?.length) {
      throw Error(
        data.errors
          .map(error => error.message)
          .join(", ")
      );
    }

    if (!data.data?.stopPlace) {
      throw Error("Bekkestua stop not found");
    }

    const calls = data.data.stopPlace.estimatedCalls || [];

    routes.forEach((route, index) => {
      lists[index] = calls
        .filter(call => {
          const line = call.serviceJourney?.line;

          const destination =
            call.destinationDisplay?.frontText;

          return (
            !call.cancellation &&
            String(line?.publicCode) === route.line &&
            line?.transportMode === route.mode &&
            norm(destination).includes(norm(route.match))
          );
        })
        .map(call => ({
          time: Date.parse(call.expectedDepartureTime)
        }))
        .filter(call => Number.isFinite(call.time))
        .sort((a, b) => a.time - b.time);
    });

    updated = Date.now();

    $("transport-status").textContent =
      `Entur updated at ${time(updated)} · ` +
      "8-minute walk to Bekkestua";
  } catch (error) {
    $("transport-status").textContent =
      `Transport update failed: ${error.message}. ` +
      (
        updated
          ? "Previously loaded departures retained until stale."
          : "No departure data loaded yet."
      );
  } finally {
    busy = false;
    render();
  }
}


/* ==========================================================
   7. RENDER TRANSPORT TICKETS

   Blue:     More than 10 minutes before departure
   Yellow:   10 to 8 minutes before departure
   Red:      8 to 7 minutes before departure
   Dark red: 7 to 6 minutes 30 seconds before departure
   Then:     Advance to the next eligible departure
   ========================================================== */

function render() {
  const now = Date.now();

  const cutoff =
    CONFIG.tooLateMinutes * 60_000 -
    CONFIG.tooLateSeconds * 1_000;

  const stale =
    updated > 0 &&
    now - updated > CONFIG.staleAfterMs;

  routes.forEach((route, index) => {
    const card = $(`ticket-${index}`);

    const departure = card.querySelector(".departure");
    const status = card.querySelector(".status");
    const next = card.querySelector(".next-time");
    const label = card.querySelector(".next-label");

    let state = "";
    let progress = 0;

    label.textContent = `Next ${route.mode} at`;

    // Hide actionable times when offline, stale, or not loaded.
    if (!navigator.onLine || !updated || stale) {
      state = "unavailable";

      departure.textContent = "--:--";
      next.textContent = "--:--";

      if (!navigator.onLine) {
        status.textContent =
          "Offline — live departures unavailable";
      } else if (stale) {
        status.textContent =
          "Data outdated — waiting for refresh";
      } else {
        status.textContent = "Loading departures…";
      }
    } else {
      const usable = lists[index].filter(call => {
        return call.time - now > cutoff;
      });

      const [current, following] = usable;

      if (!current) {
        state = "unavailable";

        departure.textContent = "--:--";
        next.textContent = "—";

        status.textContent =
          "No matching departure in loaded time window";
      } else {
        departure.textContent = time(current.time);

        next.textContent = following
          ? time(following.time)
          : "—";

        if (!following) {
          label.textContent = `No later ${route.mode} loaded`;
        }

        const remaining =
          (current.time - now) / 60_000;

        if (remaining <= CONFIG.tooLateMinutes) {
          state = "too-late";
          progress = 1;

          status.textContent = "TOO LATE";
        } else if (remaining <= CONFIG.walkMinutes) {
          state = "leave-now";
          progress = 1;

          status.textContent = "LEAVE NOW";
        } else {
          const minutesUntilLeave = Math.max(
            1,
            Math.ceil(remaining - CONFIG.walkMinutes)
          );

          status.textContent =
            `LEAVE IN ${minutesUntilLeave} MIN`;

          if (remaining <= CONFIG.yellowMinutes) {
            state = "warning";
          }

          progress = Math.max(
            0,
            Math.min(
              1,
              1 -
                (remaining - CONFIG.walkMinutes) /
                CONFIG.blueFillWindowMinutes
            )
          );
        }
      }
    }

    // Keep unchanged classes in place so the glow stays smooth.
    const stateClasses = [
      "warning",
      "leave-now",
      "too-late",
      "unavailable"
    ];

    stateClasses.forEach(name => {
      card.classList.toggle(name, state === name);
    });

    card.style.setProperty(
      "--progress",
      `${progress * 100}%`
    );
  });
}


/* ==========================================================
   8. WEATHER DESCRIPTIONS AND ICONS
   ========================================================== */

function describe(code, day) {
  if (code === 0) {
    return [
      day ? "☀️" : "🌙",
      "Clear sky"
    ];
  }

  if ([1, 2].includes(code)) {
    return [
      day ? "🌤️" : "☁️",
      "Partly cloudy"
    ];
  }

  if (code === 3) {
    return ["☁️", "Overcast"];
  }

  if ([45, 48].includes(code)) {
    return ["🌫️", "Fog"];
  }

  if ([51, 53, 55, 56, 57].includes(code)) {
    return ["🌦️", "Drizzle"];
  }

  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return ["🌧️", "Rain"];
  }

  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    return ["🌨️", "Snow"];
  }

  if ([95, 96, 99].includes(code)) {
    return ["⛈️", "Thunderstorm"];
  }

  return ["🌡️", "Weather"];
}


/* ==========================================================
   9. FETCH CURRENT WEATHER AND FORECAST
   ========================================================== */

async function weather() {
  if (weatherBusy) return;

  weatherBusy = true;

  try {
    const params = new URLSearchParams({
      latitude: CONFIG.latitude,
      longitude: CONFIG.longitude,

      current: [
        "temperature_2m",
        "apparent_temperature",
        "weather_code",
        "wind_speed_10m",
        "precipitation",
        "is_day"
      ].join(","),

      hourly: [
        "temperature_2m",
        "precipitation"
      ].join(","),

      daily: [
        "sunrise",
        "sunset"
      ].join(","),

      wind_speed_unit: "ms",
      forecast_days: "3",
      timezone: CONFIG.timeZone,
      timeformat: "unixtime"
    });

    const data = await json(
      `https://api.open-meteo.com/v1/forecast?${params}`
    );

    const current = data.current;

    const [icon, label] = describe(
      current.weather_code,
      !!current.is_day
    );

    $("weather-icon").textContent = icon;

    $("temp").textContent =
      `${Math.round(current.temperature_2m)}°`;

    $("conditions").textContent = label;

    $("feels").textContent =
      `${Math.round(current.apparent_temperature)}°`;

    $("wind").textContent =
      `${current.wind_speed_10m.toFixed(1)} m/s`;

    $("rain").textContent =
      `${current.precipitation} mm`;

    forecast(data.hourly, data.daily);

    weatherUpdated = Date.now();

    $("weather-status").textContent =
      `Weather updated at ${time(weatherUpdated)} · Oslo time`;
  } catch (error) {
    $("weather-status").textContent =
      `Weather update failed: ${error.message}` +
      (
        weatherUpdated
          ? ` · Previous forecast from ${time(weatherUpdated)} shown.`
          : ""
      );
  } finally {
    weatherBusy = false;
  }
}


/* ==========================================================
   10. WEATHER CHART — PREPARE DATA
   ========================================================== */

function forecast(hourly, daily) {
  if (typeof Chart === "undefined") {
    throw Error("Chart library could not be loaded");
  }

  const start =
    Math.floor(Date.now() / HOUR) * HOUR;

  const end = start + 24 * HOUR;

  const samples = hourly.time.map((timestamp, index) => ({
    time: timestamp * 1_000,
    temperature: hourly.temperature_2m[index],
    precipitation: hourly.precipitation[index]
  }));

  const temperaturePoints = samples
    .filter(point => {
      return (
        point.time >= start &&
        point.time <= end &&
        Number.isFinite(point.temperature)
      );
    })
    .map(point => ({
      x: point.time,
      y: point.temperature
    }));

  // Each precipitation value belongs to the preceding hour.
  const precipitationPoints = samples
    .filter(point => {
      return (
        point.time > start &&
        point.time <= end &&
        Number.isFinite(point.precipitation)
      );
    })
    .map(point => ({
      x: point.time - HOUR / 2,
      y: point.precipitation
    }));


  /* --------------------------------------------------------
     Temperature axis: at least a 10°C vertical range
     -------------------------------------------------------- */

  const temperatures = temperaturePoints.map(point => point.y);

  const lowestTemperature = temperatures.length
    ? Math.min(...temperatures)
    : 0;

  const highestTemperature = temperatures.length
    ? Math.max(...temperatures)
    : 10;

  const temperatureMidpoint =
    (lowestTemperature + highestTemperature) / 2;

  const temperatureRange = Math.max(
    10,
    highestTemperature - lowestTemperature + 2
  );

  const temperatureAxisMin = Math.floor(
    temperatureMidpoint - temperatureRange / 2
  );

  const temperatureAxisMax = Math.ceil(
    temperatureMidpoint + temperatureRange / 2
  );


  /* --------------------------------------------------------
     Sunrise, sunset, and daylight intervals
     -------------------------------------------------------- */

  const daylightIntervals = (daily?.sunrise || [])
    .map((rise, index) => ({
      sunrise: rise == null
        ? NaN
        : rise * 1_000,

      sunset: daily.sunset[index] == null
        ? NaN
        : daily.sunset[index] * 1_000
    }))
    .filter(interval => {
      return (
        Number.isFinite(interval.sunrise) &&
        Number.isFinite(interval.sunset) &&
        interval.sunset > start &&
        interval.sunrise < end
      );
    });

  const sunEvents = daylightIntervals
    .flatMap(interval => [
      {
        time: interval.sunrise,
        label: "Sunrise",
        color: "#f8d783"
      },
      {
        time: interval.sunset,
        label: "Sunset",
        color: "#c4b5fd"
      }
    ])
    .filter(event => {
      return event.time >= start && event.time <= end;
    });


  /* ========================================================
     11. WEATHER CHART — DAY/NIGHT BACKGROUND PLUGIN
     ======================================================== */

  const daylightPlugin = {
    id: "daylightBackground",

    beforeDraw(instance) {
      const { ctx, chartArea, scales } = instance;

      if (!chartArea) return;

      const { left, right, top, bottom } = chartArea;

      ctx.save();

      // Nighttime base.
      ctx.fillStyle = "#080f1d";

      ctx.fillRect(
        left,
        top,
        right - left,
        bottom - top
      );

      // Lighter daylight areas.
      ctx.fillStyle = "#24354a";

      daylightIntervals.forEach(interval => {
        const visibleStart = Math.max(
          start,
          interval.sunrise
        );

        const visibleEnd = Math.min(
          end,
          interval.sunset
        );

        if (visibleEnd <= visibleStart) return;

        const x1 = scales.x.getPixelForValue(
          visibleStart
        );

        const x2 = scales.x.getPixelForValue(
          visibleEnd
        );

        ctx.fillRect(
          x1,
          top,
          x2 - x1,
          bottom - top
        );
      });

      ctx.restore();
    },

    afterDraw(instance) {
      const { ctx, chartArea, scales } = instance;

      if (!chartArea) return;

      const { left, right, top, bottom } = chartArea;

      ctx.save();

      sunEvents.forEach(event => {
        const x = scales.x.getPixelForValue(
          event.time
        );

        // Vertical boundary.
        ctx.strokeStyle = event.color;
        ctx.globalAlpha = 0.65;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 5]);

        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();

        // Label above the plotting area.
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);

        ctx.fillStyle = event.color;
        ctx.font = "600 11px system-ui";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";

        const label =
          `${event.label} ${time(event.time)}`;

        const labelWidth =
          ctx.measureText(label).width;

        const labelX = Math.max(
          left,
          Math.min(
            x - labelWidth / 2,
            right - labelWidth
          )
        );

        ctx.fillText(
          label,
          labelX,
          top - 8
        );
      });

      ctx.restore();
    }
  };


  /* ========================================================
     12. WEATHER CHART — DATASETS AND OPTIONS
     ======================================================== */

  if (chart) {
    chart.destroy();
  }

  chart = new Chart($("chart"), {
    type: "line",

    plugins: [
      daylightPlugin
    ],

    data: {
      datasets: [
        {
          type: "line",

          label: "Temperature °C",
          data: temperaturePoints,

          borderColor: "#fbbf24",
          backgroundColor: "#fbbf24",

          fill: false,
          tension: 0.35,

          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 3,

          yAxisID: "temperature",
          order: 1
        },
        {
          type: "bar",

          label: "Precipitation mm",
          data: precipitationPoints,

          backgroundColor: "#58a6efcc",
          hoverBackgroundColor: "#7bc4ff",

          borderColor: "#8acbff",
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,

          barThickness: "flex",
          categoryPercentage: 1,
          barPercentage: 0.72,

          yAxisID: "precipitation",
          order: 2
        }
      ]
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,

      layout: {
        padding: {
          top: 24
        }
      },

      interaction: {
        mode: "nearest",
        axis: "x",
        intersect: false
      },

      plugins: {
        legend: {
          position: "bottom",
          display: false,

          labels: {
            color: "#cbd5e1",
            usePointStyle: true,
            padding: 18
          }
        },

        tooltip: {
          backgroundColor: "#0b1425",
          titleColor: "#fff",
          bodyColor: "#dce9ff",

          borderColor: "#ffffff22",
          borderWidth: 1,
          padding: 12,

          callbacks: {
            title(items) {
              if (!items.length) return "";

              const item = items[0];

              if (item.dataset.type === "bar") {
                const intervalStart =
                  item.parsed.x - HOUR / 2;

                const intervalEnd =
                  item.parsed.x + HOUR / 2;

                return (
                  `${time(intervalStart)}–` +
                  `${time(intervalEnd)}`
                );
              }

              return time(item.parsed.x);
            },

            label(context) {
              if (context.dataset.type === "bar") {
                return (
                  "Precipitation: " +
                  `${context.parsed.y.toFixed(1)} mm`
                );
              }

              return (
                "Temperature: " +
                `${context.parsed.y.toFixed(1)} °C`
              );
            }
          }
        }
      },


      /* ----------------------------------------------------
         Chart axes
         ---------------------------------------------------- */

      scales: {
        x: {
          type: "linear",

          min: start,
          max: end,
          offset: false,

          ticks: {
            stepSize: 2 * HOUR,
            color: "#a8bad0",
            font: {
              size: 14,
              weight: "bold"
            },
            maxRotation: 0,

            callback(value) {
              return time(Number(value));
            }
          },

          grid: {
            color: "#ffffff0b"
          }
        },

        temperature: {
          position: "left",

          min: temperatureAxisMin,
          max: temperatureAxisMax,

          title: {
            display: true,
            text: "Temperature °C",
            color: "#fbbf24"
          },

          ticks: {
            color: "#fbbf24",
            stepSize: 2,
            font: {
              size: 16,
              weight: "bold"
            },
          },

          grid: {
            color: "#ffffff0e"
          }
        },

        precipitation: {
          position: "right",

          min: 0,
          suggestedMax: 5,

          title: {
            display: true,
            text: "Precipitation mm / hour",
            color: "#7bc4ff"
          },

          ticks: {
            color: "#7bc4ff",
            maxTicksLimit: 6,
            font: {
              size: 16,
              weight: "bold"
            },
          },

          grid: {
            drawOnChartArea: false
          }
        }
      }
    }
  });
}


/* ==========================================================
   13. ANDROID APP INSTALLATION
   ========================================================== */

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();

  installPrompt = event;
  $("install").hidden = false;
});

$("install").addEventListener("click", async () => {
  if (!installPrompt) return;

  await installPrompt.prompt();
  await installPrompt.userChoice;

  installPrompt = null;
  $("install").hidden = true;
});

window.addEventListener("appinstalled", () => {
  $("install").hidden = true;
});


/* ==========================================================
   14. CONNECTION STATUS AND MANUAL REFRESH
   ========================================================== */

function connection() {
  $("connection").textContent = navigator.onLine
    ? ""
    : "Offline: live transport and weather require an internet connection.";

  render();
}

function refreshData() {
  clock();
  render();

  transport();
  weather();
}

$("refresh").addEventListener("click", refreshData);

window.addEventListener("online", () => {
  connection();
  refreshData();
});

window.addEventListener("offline", connection);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshData();
  }
});


/* ==========================================================
   15. SERVICE WORKER
   ========================================================== */

if (
  "serviceWorker" in navigator &&
  window.isSecureContext
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .catch(error => {
        $("connection").textContent =
          `Offline app setup failed: ${error.message}`;
      });
  });
}


/* ==========================================================
   16. STARTUP AND AUTOMATIC REFRESH
   ========================================================== */

clock();
render();
connection();

transport();
weather();

// Update the clock, ticket countdowns, and visual states.
setInterval(() => {
  clock();
  render();
}, 1_000);

// Refresh departures while the app is visible.
setInterval(() => {
  if (!document.hidden) {
    transport();
  }
}, CONFIG.transportRefreshMs);

// Refresh weather while the app is visible.
setInterval(() => {
  if (!document.hidden) {
    weather();
  }
}, CONFIG.weatherRefreshMs);