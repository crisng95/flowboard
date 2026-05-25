import type { Edge } from "@xyflow/react";

import type { FlowNode, FlowboardEdgeData } from "../store/board";

export type SpaceTemplate = {
  id: string;
  name: string;
  updatedLabel: string;
  snapshot: {
    nodes: FlowNode[];
    edges: Edge<FlowboardEdgeData>[];
  };
};

export const SPACE_TEMPLATES: SpaceTemplate[] = [
  {
    id: "template-image-starter",
    name: "Template: Create images",
    updatedLabel: "Starter template",
    snapshot: {
      nodes: [
        {
          id: "tpl-text-1",
          type: "text",
          position: { x: 80, y: 120 },
          data: {
            type: "text",
            shortId: "tpl1",
            title: "Text",
            prompt: "A cinematic portrait with dramatic side light and clean background.",
            status: "idle",
          },
        },
        {
          id: "tpl-gen-1",
          type: "reference",
          position: { x: 420, y: 86 },
          data: {
            type: "reference",
            shortId: "tpl2",
            title: "Image Generator",
            prompt: "Describe the image you want to generate...",
            status: "idle",
            aspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT",
          },
          style: { width: 360, height: 420 },
        },
      ],
      edges: [
        {
          id: "tpl-edge-1",
          source: "tpl-text-1",
          target: "tpl-gen-1",
          targetHandle: "target-text",
        },
      ],
    },
  },
  {
    id: "template-reference-mix",
    name: "Template: Build from references",
    updatedLabel: "Reference workflow",
    snapshot: {
      nodes: [
        {
          id: "tpl-ref-text",
          type: "text",
          position: { x: 90, y: 90 },
          data: {
            type: "text",
            shortId: "tpl3",
            title: "Text",
            prompt: "Luxury footwear campaign photo, premium studio finish.",
            status: "idle",
          },
        },
        {
          id: "tpl-ref-node",
          type: "add_reference",
          position: { x: 70, y: 270 },
          data: {
            type: "add_reference",
            shortId: "tpl4",
            title: "Reference",
            prompt: "Reference prompt",
            status: "idle",
            refType: "Style",
          },
          style: { width: 260, height: 260 },
        },
        {
          id: "tpl-ref-gen",
          type: "reference",
          position: { x: 430, y: 122 },
          data: {
            type: "reference",
            shortId: "tpl5",
            title: "Image Generator",
            prompt: "Describe the image you want to generate...",
            status: "idle",
            aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
          },
          style: { width: 360, height: 420 },
        },
      ],
      edges: [
        {
          id: "tpl-edge-2",
          source: "tpl-ref-text",
          target: "tpl-ref-gen",
          targetHandle: "target-text",
        },
        {
          id: "tpl-edge-3",
          source: "tpl-ref-node",
          target: "tpl-ref-gen",
          targetHandle: "target-image",
        },
      ],
    },
  },
];
