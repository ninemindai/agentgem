import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ContentView, renderMarkdown } from "./ContentView.js";

afterEach(cleanup);

describe("ContentView", () => {
  it("renders markdown by default and toggles to raw", () => {
    const { container } = render(<ContentView text={"# Title\n\nsome **body**"} />);
    // markdown view: a real <h1> and <strong>
    expect(container.querySelector(".cv-md h1")?.textContent).toBe("Title");
    expect(container.querySelector(".cv-md strong")?.textContent).toBe("body");
    // toggle to raw shows the source text verbatim
    fireEvent.click(screen.getByText("Raw"));
    expect(container.querySelector(".cv-raw")?.textContent).toBe("# Title\n\nsome **body**");
  });
});

describe("renderMarkdown", () => {
  it("strips script/xss vectors via DOMPurify", () => {
    const html = renderMarkdown("ok <script>alert(1)</script> <img src=x onerror=alert(2)>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).toMatch(/ok/);
  });

  it("drops leading YAML frontmatter", () => {
    const html = renderMarkdown("---\nname: pdf\ndescription: x\n---\n\n# Heading\n\nbody");
    expect(html).not.toMatch(/name: pdf/);
    expect(html).toMatch(/<h1[^>]*>Heading<\/h1>/);
  });
});
