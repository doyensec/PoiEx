var vscode = acquireVsCodeApi();

function openPoi(poiUUID) {
    console.log("[IaC PoiView (webview)] Opening POI: " + poiUUID);
    vscode.postMessage({
        command: 'openPoi',
        poiUUID: poiUUID
    });
}

function openIaC() {
    console.log("[IaC PoiView (webview)] Opening IaC definition");
    vscode.postMessage({
        command: 'openIaC'
    });
}

var container = document.getElementById('container');
let res = `<table class="poitable">
<tr>
<th class="poith">Points of Intersection and findings for: <i>${poiFilter}</i></th>
</tr>`;
// Show the list of POIs
for (let i = 0; i < poiList.length; i++) {
    let poiName = poiList[i][0].replace("IaC Point Of Intersection: ", "");
    res += `<tr class="poitr"><td href='#' onclick='openPoi(this.id)' id="${poiName}" class="poitd">` + poiList[i][1] + ` @ ${poiList[i][2]}:${poiList[i][3]}` + "</td>" + "</tr>";
}
res += "</table>";

// Add IaC definition
let iacRes = `<table class="iactable">
<tr>
<th class="iacth">IaC definition for: <i>${poiFilter}</i></th>
</tr>`;

iacRes += `<tr class="iactr" onclick="openIaC()"><td class="iactd"><pre>` + iacResource + "</pre></td>" + "</tr>";

res += iacRes;

container.innerHTML = res;