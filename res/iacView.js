var vscode = acquireVsCodeApi();

var parsedData = vis.parseDOTNetwork(DOTstring);

var data = {
    nodes: parsedData.nodes,
    edges: parsedData.edges
};

let counterMap = new Map();
for (let i = 0; i < parsedData.nodes.length; i++) {
    let node = parsedData.nodes[i].id;
    let res = 0;
    console.log(node);
    for (let poi of poiList) {
        let providerFilter = "";
        let serviceFilter = "";
        let poiFilter = node.split(".")[0];
        let poiFilterParts = poiFilter.split("_");
        if (poiFilterParts.length >= 1) {
            providerFilter = poiFilter.split("_")[0];
        }
        if (poiFilterParts.length >= 2) {
            serviceFilter = poiFilter.split("_")[1];
        }

        console.log(poi);
        if (poi.toLowerCase().includes(providerFilter) && poi.toLowerCase().includes(serviceFilter)) {
            console.log("Found POI for node: " + node);
            res++;
        }
    }

    for (let finding of findingsList) {
        if (finding.toLowerCase().includes(node.toLowerCase())) {
            res++;
        }
    } 

    counterMap.set(node, res);
}

// create a network
var container = document.getElementById('diagram');

var options = {};

// initialize your network!
var network = new vis.Network(container, data, options);

network.on("doubleClick", function (params) {
    let node = this.getNodeAt(params.pointer.DOM);
    vscode.postMessage({
        command: 'nodeClicked',
        nodeId: node
    });
});

const BUBBLE_X_OFFSET = 20;
const BUBBLE_Y_OFFSET = -20;

const PALETTE = {
    "primary": "#E65100",
    "text": "#FAFAFA"
};

network.on("afterDrawing", function (ctx) {
    for (let i = 0; i < parsedData.nodes.length; i++) {
        // Draw a bubble with the number of POIs
        var nodeId = parsedData.nodes[i].id;
        let res = counterMap.get(nodeId);
        if (res === undefined) {
            res = 0;
        }
        if (res > 0) {
            var nodePosition = network.getPositions([nodeId]);
            
            ctx.beginPath();
            ctx.arc(nodePosition[nodeId].x + BUBBLE_X_OFFSET, nodePosition[nodeId].y + BUBBLE_Y_OFFSET, 13, 0, 2 * Math.PI, false);
            ctx.fillStyle = PALETTE.primary;
            ctx.fill();

            ctx.font = "15px Roboto";
            ctx.fillStyle = PALETTE.text;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(res, nodePosition[nodeId].x + BUBBLE_X_OFFSET, nodePosition[nodeId].y + BUBBLE_Y_OFFSET + 1);
        } 
    }
});