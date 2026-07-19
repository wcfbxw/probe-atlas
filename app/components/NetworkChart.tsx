"use client";

import type { EChartsType } from "echarts";
import { useEffect, useRef } from "react";

export type NetworkPoint = {
  time: number;
  rx: number;
  tx: number;
};

function megabits(bytes: number) {
  return Number(((bytes * 8) / 1_000_000).toFixed(2));
}

export function NetworkChart({ points }: { points: NetworkPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | null = null;

    void import("echarts").then((echarts) => {
      if (cancelled || !containerRef.current) {
        return;
      }
      chartRef.current = echarts.init(containerRef.current, undefined, {
        renderer: "canvas",
      });
      observer = new ResizeObserver(() => chartRef.current?.resize());
      observer.observe(containerRef.current);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    chart.setOption({
      animationDuration: 360,
      grid: { top: 18, right: 12, bottom: 26, left: 48 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(7, 18, 30, .96)",
        borderColor: "#1d3b51",
        textStyle: { color: "#d8e7ef", fontSize: 12 },
        valueFormatter: (value: number) => `${value.toFixed(2)} Mbps`,
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: points.map((point) =>
          new Date(point.time).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        ),
        axisLine: { lineStyle: { color: "#1e3445" } },
        axisTick: { show: false },
        axisLabel: {
          color: "#668092",
          fontSize: 10,
          interval: Math.max(Math.floor(points.length / 5), 1),
        },
      },
      yAxis: {
        type: "value",
        min: 0,
        axisLabel: {
          color: "#668092",
          fontSize: 10,
          formatter: "{value}M",
        },
        splitLine: { lineStyle: { color: "rgba(61, 92, 111, .2)" } },
      },
      series: [
        {
          name: "下载",
          type: "line",
          data: points.map((point) => megabits(point.rx)),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: "#36d9b0", width: 2 },
          areaStyle: { color: "rgba(54, 217, 176, .12)" },
        },
        {
          name: "上传",
          type: "line",
          data: points.map((point) => megabits(point.tx)),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: "#55a8ff", width: 2 },
          areaStyle: { color: "rgba(85, 168, 255, .08)" },
        },
      ],
    });
  }, [points]);

  return (
    <div
      ref={containerRef}
      className="network-chart"
      role="img"
      aria-label="实时网络下载和上传速率趋势图"
    />
  );
}
