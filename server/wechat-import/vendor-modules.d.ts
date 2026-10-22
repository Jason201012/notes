declare module "turndown" {
  interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    hr?: string;
    bulletListMarker?: "-" | "+" | "*";
    codeBlockStyle?: "indented" | "fenced";
    fence?: string;
    emDelimiter?: "_" | "*";
    strongDelimiter?: "__" | "**";
    linkStyle?: "inlined" | "referenced";
  }

  interface TurndownNode {
    nodeName: string;
    className?: string;
    textContent?: string | null;
    outerHTML?: string;
    firstChild?: TurndownNode | null;
    getAttribute?(name: string): string | null;
  }

  interface TurndownRule {
    filter:
      | string
      | readonly string[]
      | ((node: TurndownNode, options: TurndownOptions) => boolean);
    replacement: (
      content: string,
      node: TurndownNode,
      options: TurndownOptions,
    ) => string;
  }

  class TurndownService {
    constructor(options?: TurndownOptions);
    use(
      plugin:
        | ((service: TurndownService) => void)
        | Array<(service: TurndownService) => void>,
    ): this;
    addRule(key: string, rule: TurndownRule): this;
    turndown(input: string): string;
  }

  export default TurndownService;
}

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export function gfm(service: TurndownService): void;
}
