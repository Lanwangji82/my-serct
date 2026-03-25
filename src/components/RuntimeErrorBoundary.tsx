// @ts-nocheck
import React from "react";
import { Button, Card } from "./ui";

type Props = {
  area: string;
  children: ReactNode;
};

type State = {
  hasError: boolean;
  message: string;
};

export class RuntimeErrorBoundary extends React.Component<Props, State> {
  state: State = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || "Unknown runtime error",
    };
  }

  componentDidCatch(error: Error) {
    console.error(`[RuntimeErrorBoundary:${this.props.area}]`, error);
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: "" });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <Card className="border-rose-500/30 bg-zinc-950/90">
        <div className="space-y-4 p-6">
          <div>
            <h2 className="text-lg font-semibold text-zinc-50">{this.props.area} 已保护性中断</h2>
            <p className="mt-1 text-sm text-zinc-400">
              为了避免整个应用黑屏，这个区域已被隔离。可以先重试；如果还复现，错误信息会保留在这里。
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-rose-300">
            {this.state.message}
          </div>
          <div className="flex gap-3">
            <Button onClick={this.handleReset}>重试此区域</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              刷新页面
            </Button>
          </div>
        </div>
      </Card>
    );
  }
}
