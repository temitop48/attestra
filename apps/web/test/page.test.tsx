import React from "react";
import { describe, expect, it } from "vitest";
import Home from "../src/app/page";

describe("home page", () => {
  it("renders the public product surface and accurate CTAs", () => {
    const page = Home();

    expect(React.isValidElement(page)).toBe(true);
    const children = page.props.children;
    expect(children[0].props["aria-label"]).toBe("Primary navigation");
    expect(children[1].props.id).toBe("product");
    expect(children[1].props.children[0].props.children[1].props.children).toContain("Hire AI agents.");
    expect(children[1].props.children[0].props.children[3].props.children[0].props.href).toBe("/workspace");
    expect(children[2].props.id).toBe("how-it-works");
    expect(children[3].props.id).toBe("agents");
    expect(children[4].props.id).toBe("security");
  });
});
