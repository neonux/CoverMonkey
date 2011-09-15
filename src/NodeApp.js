// This code expects the Coverage class and its various 
// properties defined in Coverage.js, but that file is not a Node
// module, so ../Makefile just creates a CoverMonkey file by
// concatenating Coverage.js with this file.
// 
// XXX: it might be nice if the code in this file could just call the 
// the coverage() function and use its output.  But it isn't currently 
// written to do that. Refactoring is possible, but calling coverage()
// directly would mean that -D data can't be streamed: I'd have to read
// all the data and then process it in one big chunk...
//
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var console = require("console");
var util = require("util");

const VERSION = "0.15";

function usage(code) {
    var done = process.stdout.write(
"Usage: CoverMonkey [options]\n" +
"\n" +
"    CoverMonkey reads the output generated by SpiderMonkey's -D option\n" +
"    (supported by debug builds of SpiderMonkey only) and analyzes it to\n" +
"    detect dead code and report code coverage.\n" +
"\n" +
"    CoverMonkey reads -D data from stdin by default. Use the -d option\n" +
"    to make it read from a file instead.\n" +
"\n" +
"    CoverMonkey writes basic code coverage statistics to stdout.\n" +
"    Use -q, -p, -c and -l to modify the information displayed.\n" +
"\n" +
"    CoverMonkey can generate an HTML file that annotates and colors your \n" +
"    source code to highlight uncovered and dead code and indicate how\n" +
"    many times each line executed.  Use the -h, -a, and -b options to \n" +
"    control HTML generation.\n" +
"\n" +
"    By default, CoverMonkey will output coverage information for all \n" +
"    source files that were run. Use one or more -t options to specify\n" +
"    which files CoverMonkey should analyze.\n" +
"\n" +
" Options:\n" +
"\n" +
"    -d <file> Read -D data from the specified file instead of stdin\n" +
"\n" +
"    -t <file> Analyze coverage for the specified target file.\n" +
"              Multiple -t options are allowed.\n" +
"\n" +
"    -q        Quiet: don't display any output to stdout\n" +
"\n" +
"    -p        Percent: only display coverage percentage\n" +
"\n" +
"    -c        Display the coverage statistics in compact tabular form\n" +
"\n" +
"    -l        List the line numbers of all uncovered lines\n" +
"\n" +
"    -h <file> Output annotated source code, in HTML format, to the \n" +
"              specified file.\n" +
"\n" +
"    -a        Include assembly code for each line in the HTML file.\n" +
"              This may be useful for understanding partially-covered\n" +
"              lines.\n" +
"\n" +
"    -b        Automatically launch a browser window to display the\n" +
"              HTML. If no -h option, writes HTML to a temporary file.\n" +
"              This option may only work on MacOS.\n" +
"\n" +
"    --atlines Honor //@line comments in the source\n" +
"              This option is probably not generally useful\n" +
"\n" +
"    --noecho  CoverMonkey normally echos lines read from stdin to stdout\n" +
"              if they are not -D output. With this option it does not.\n" +
"\n" +
"    -v        Display the CoverMonkey version number and exit\n" +
"\n" +
"    --help    Display this message and exit\n" +
""
    );

    if (done) process.exit(code);
    else process.stdout.on('drain', function() { process.exit(code); });

}


// Loop through the command-line arguments collecting input files and options
var options = {
    input: null,
    quiet: false,     // quiet: don't write to stdout
    percent: false,   // percents: only output coverage %
    compact: false,   // tabular output
    listlines: false, // list individual uncovered lines
    targets: [],      // Which js files do we want stats on?
    htmlfile: null,
    overwrite: false,
    openhtml: false,  // automatically open the html file in a browser?
    outputops: false,
    atlines: false,
    echo: true,
};


process.argv.shift();  // throw away the path to node
process.argv.shift();  // throw away the path to this script

while(process.argv.length) {
    var arg = process.argv.shift();
    switch(arg) {
    case '--help':
        usage(0);
        break;
    case '-v':
        console.log(VERSION);
        process.exit(0);
        break;
    case '-d':
        if (!process.argv.length || options.inputfile) usage(1);
        options.input = fs.createReadStream(process.argv.shift(),
                                            { encoding: "utf8"});
        break;
    case '-q':
        options.quiet = true;
        break;
    case '-p':
        options.percent = true;
        break;
    case '-c':
        options.compact = true;
        break;
    case '-l':
        options.listlines = true;
        break;
    case '-t':
        if (!process.argv.length) usage(1);
        options.targets.push(process.argv.shift());
        break;
    case '-h':
        if (!process.argv.length) usage(1);
        if (options.htmlfile) usage(1); // only specify one
        options.htmlfile = process.argv.shift();
        break;
    case '-f':
        options.overwrite = true;
        break;
    case '-b':
        options.openhtml = true;
        break;
    case '-a':
        options.outputops = true;
        break;
    case '--atlines':
        options.atlines = true;
        break;
    case '--noecho':
        options.echo = false;
        break;
    default: 
        console.log("Unexpected argument: %s", arg);
        usage(1);
        break;
    }
}

// If no input file was specified, then read text from standard in
if (!options.input) {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    options.input = process.stdin;
}

// Collect the coverage information, then analyze and report it
parseScripts(options.input, analyzeAndReportCoverage);


// Pass in a source file and line number (sfile, sline)
// Returns the corresponding "virtual" file and line [vfile, vline]
// based on @line comments in the specified source file, if any
function remap(sfile, sline) {
    if (remap.lastfile === sfile && remap.lastline === sline)
        return remap.lastresult;

    var atlines = atlineMap[sfile]
    if (!atlines) {
        atlines = [];
        var srclines = fs.readFileSync(sfile, "utf8").split("\n");
        srclines.forEach(function(l, n) {
            var match = l.match(atlinePattern);
            if (match) {
                atlines.push({
                    pline: n+1,
                    vline: parseInt(match[1]),
                    vfile: match[2]
                });
            }
        })
        
        atlineMap[sfile] = atlines;
    }

    var vfile = sfile, vline = sline;

    for(var i = 0; i < atlines.length; i++) {
        var a = atlines[i];
        if (a.pline >= sline) break;
        else {
            vfile = a.vfile;
            vline = sline - a.pline + a.vline - 1;
        }
    }

    remap.lastfile = sfile;
    remap.lastline = sline;
    return remap.lastresult = [vfile, vline];
}

// Maps filenames to an array of AtLine objects
var atlineMap = {};
// What an @line comment looks like
var atlinePattern = /\/\/@line (\d+) "([^"]+)"/;

// Read a stream of -D data and parse it. Interpret filenames relative to
// the specified directory.  If stream is stdin then any lines before the
// beginning of the -D data are printed to stdout.
function parseScripts(stream, callback) {
    var fragment = "";  // line fragments we haven't processed yet
    var parser = new Coverage.Parser(options.atlines ? remap : null);

    stream.on('data', function(chunk) {
        // Add any pending fragment to this chunk and break into lines
        var lines = (fragment + chunk).split("\n");
        
        // The last element of the array is an unterminated line
        fragment = lines.pop();
        
        // Now process the complete lines we got
        lines.forEach(function(line) {
            var consumed = parser.processLine(line);
            if (!consumed && stream === process.stdin && options.echo) {
                console.log(line);
            }
        });
    });

    stream.on('end', function() {
        if (fragment != "") {
            var consumed = parser.processLine(fragment);
            if (!consumed && stream === process.stdin && options.echo) {
                console.log(fragment);
            }
        }

        if (parser.scripts.length === 0) {
            console.log("CoverMonkey: No coverage data to process.\n" +
                        "CoverMonkey: Are you using a debug build of spidermonkey?");
            process.exit(0);
        }

        callback(parser.scripts);
    });
}


// Analyize the input and generate the output
function analyzeAndReportCoverage(scripts) {
    var data = {};

    // Convert the array of Script objects to an object mapping filenames
    // to File objects
    scripts.forEach(function(script) {
        var filename = script.filename;
        if (!(filename in data)) {
            data[filename] = new Coverage.File(filename);
        }
        var file = data[filename];

        script.opcodes.forEach(function(opcode) {
            file.line(opcode.srcline).addOpcode(script.name + ":" + opcode.pc,
                                                opcode);
        });
    });


    // If no targets were specified, use all known files as targets
    if (options.targets.length === 0) { 
        for(filename in data) {
            // -D outputs a "(null)" script for the toplevel
            if (path.basename(filename) === "(null)") continue;
            options.targets.push(filename);
        }
        options.targets.sort();         // Alphabetially
    }

    // Now loop through the targets and output coverage data for each one
    // Unless the -q option was used
    if (!options.quiet) {

        var total = {
            lines: 0, 
            covered: 0,
            partial: 0,
            uncovered: 0,
            dead: 0
        };

        if (options.compact) {
            console.log("%s %s", pad(47), pad.center("Coverage", 28));
            console.log("Cover% %s %s %s %s %s %s",
                        pad.right("Filename", 32),
                        pad.right("Lines", 7),
                        pad.right("Full", 7),
                        pad.right("Partial", 7),
                        pad.right("None", 7),
                        pad.right("Dead", 7));
                        
        }

        options.targets.forEach(function(target, index) {
            var file = data[target];

            // If file is null here look for a file name with the same basename
            // And alter the target in the array
            if (!file) {
                target = path.basename(target);

                for(var filename in data) {
                    if (path.basename(filename) === target) {
                        target = filename;
                        file = data[filename];
                        options.targets[index] = target;
                        break;
                    }
                }
                if (!file) {
                    console.warn("Unknown target file %s", target);
                    return; 
                }
            }

            var coverage = file.coverage();
            var covered = coverage[0];
            var partial = coverage[1];
            var uncovered = coverage[2];
            var dead = coverage[3];
            var lines = covered + partial + uncovered + dead;

            total.lines += lines;
            total.covered += covered;
            total.partial += partial;
            total.uncovered += uncovered;
            total.dead += dead;

            if (options.compact) {
                console.log("%s% %s %s %s %s %s %s",
                            pad.right(percent(covered/lines), 5),
                            pad.right(target, 32),
                            pad.right(lines, 7),
                            pad.right(covered, 7),
                            pad.right(partial, 7),
                            pad.right(uncovered, 7),
                            pad.right(dead, 7));
            }
            else if (options.percent  || covered === lines) {
                console.log("%s: %s%", target, percent(covered/lines));
            }
            else {
                console.log("%s: %s%\n\t" +
                            "significant lines: %d\n\t" +
                            "          covered: %d (%s%)\n\t" +
                            "partially covered: %d (%s%)\n\t" +
                            "        uncovered: %d (%s%)\n\t" +
                            "             dead: %d (%d%)",
                            target, percent(covered/lines),  lines,
                            covered, percent(covered/lines),
                            partial, percent(partial/lines),
                            uncovered, percent(uncovered/lines),
                            dead, percent(dead/lines));

                if (options.listlines) {
                    for(linenum in file.lines) {
                        var line = file.lines[linenum];
                        var msg = null;
                        switch(line.coverage()) {
                        case 'some':
                            msg = "partially covered";
                            break;
                        case 'none':
                            msg = "uncovered";
                            break;
                        case 'dead':
                            msg = "unreachable";
                            break;
                        }
                        if (msg) console.log("%s:%d: %s",
                                             file.name, linenum, msg);
                    }
                    
                }
            }
        });

        if (options.compact) {
            console.log("%s% %s %s %s %s %s %s",
                        pad.right(percent(total.covered/total.lines), 5),
                        pad.right("ALL FILES", 32),
                        pad.right(total.lines, 7),
                        pad.right(total.covered, 7),
                        pad.right(total.partial, 7),
                        pad.right(total.uncovered, 7),
                        pad.right(total.dead, 7));
        }
        else {
            console.log("Overall Coverage: %s%",
                        percent(total.covered/total.lines));
        }
    }

    if (options.htmlfile || options.openhtml) {
        // If no html filename specified, use a temporary file
        // XXX: this may be MacOS dependent.  Surprisingly, Node
        // doesn't have temporary path creation utility.
        if (options.openhtml && !options.htmlfile) {
            options.overwrite = false;
            options.htmlfile = process.env.TMPDIR + "Coverage" +
                Math.floor(Math.random()*100000000) + ".html";
        }

        outputHTML(data, function() {
            if (options.openhtml) {
                require("child_process").spawn("open", [options.htmlfile]);
            }
        });
    }
}

// Return a string of n spaces where n is <= 50;
function pad(n) { return pad.spaces.substring(0,n); }
pad.spaces = "                                                  ";

// Return the string s centered in a field n characters wide
pad.center = function(s, n) {
    s = String(s);
    if (s.length >= n) return s;
    var left = Math.floor((n - s.length)/2),
        right = n - s.length - left;
    return pad(left) + s + pad(right);
};
// Return the string s right-justified in a field n characters wide
pad.right = function(s, n) {
    s = String(s);
    if (s.length >= n) return s.substring(s.length-n);
    return pad(n - s.length) + s;
}
// Return the string s left-justified in a field n characters wide
pad.left = function(s, n) {
    s = String(s);
    if (s.length >= n) return s.substring(0,n);
    return s + pad(n - s.length);
}


// Write an HTML file of coverage information.
// Invoke the callback when the file has been written.
function outputHTML(files, callback) {
    if (!options.htmlfile) return;

    if (!options.overwrite && path.existsSync(options.htmlfile)) {
        console.log("%s exists: no HTML output written. Use -f to force overwrite",
                    options.htmlfile);
        return;
    }

    var out = fs.createWriteStream(options.htmlfile);
    out.on("close", function() { callback(); });

    function printf(fmt) {
        out.write(util.format.apply(util, Array.prototype.slice.call(arguments,0)));
    }
    
    printf('<html><head>\n' +
           '<title>CoverMonkey Code Coverage</title>\n' + 
           '<style type="text/css">\n' +
           '.line {white-space: pre; font-family: monospace; font-weight: bold; padding:1px;}\n' +
           '.full {background-color: #fff}\n' +  // white for full coverage
           '.none {background-color: #faa}\n' +  // red for no coverage
           '.some {background-color: #ffa}\n' +  // yellow for partial coverage
           '.dead {background-color: #fca}\n' +  // orange for dead code
           '.p0 {color:#000;}\n' +
           '.p1 {color:#200;}\n' +
           '.p2 {color:#400;}\n' +
           '.p3 {color:#600;}\n' +
           '.p4 {color:#800;}\n' +
           '.p5 {color:#a00;}\n' +
           '.p6 {color:#c00;}\n' +
           '.p7 {color:#e00;}\n' +
           '.p8 {color:#f00;}\n' +
           '.p9 {color:#f00;}\n' +
           'table {border-collapse:collapse;}\n' +
           'td, th {border:solid black 1px; padding:3px 5px 3px 5px;}\n' +
           'th {background-color:rgba(0,0,0,0.1)}\n' +
           '.num {float:left; font-weight:bold; text-align:right; margin-right:1%; width:4%; text-decoration:none; color:inherit;}\n' +
           '.type {float:right; font-weight:bold; font-size:smaller; text-align:left; margin-left:1%; width:9%; }\n' +
           '.ops { margin-left: 5%; padding-left: 10px; }\n' +
           '.hidden { display:none; }\n' +
           '</style>\n' +
           '<script>\n' +
           'document.addEventListener("click", clickHandler, true);\n' +
           'function clickHandler(e) {\n' +
           '    if (e.target.classList.contains("num")) return;\n' +
           '    for(var elt = e.target; elt; elt = elt.parentNode) {\n' +
           '        if (elt.classList.contains("line")) {\n' +
           '            elt = elt.getElementsByTagName("table")[0];\n' +
           '            if (elt) elt.classList.toggle("hidden");\n' +
           '            return;\n' +
           '        }\n' +
           '    }\n' +
           '}\n' +
           '</script>\n' +
           '</head>\n' +
           '<body>\n' +
           '<h1>CoverMonkey Code Coverage</h1>\n'
          );

    
    printf('<table>\n<tr><th>Source File<th>Executable Lines' +
           '<th>Covered<th>Partial<th>Uncovered<th>Dead</tr>\n');

    // Summary table
    options.targets.forEach(function(target) {
        var file = files[target];
        var coverage = file.coverage();
        var covered = coverage[0];
        var partial = coverage[1];
        var uncovered = coverage[2];
        var dead = coverage[3];
        var lines = covered + partial + uncovered + dead;
        printf('<tr><td><a href="#%s">%s</a><td>%d' +
               '<td>%d (%d%)<td>%d (%d%)<td>%d (%d%)<td>%d (%d%)</tr>\n',
               target, target, lines, 
               covered, percent(covered/lines),
               partial, percent(partial/lines),
               uncovered, percent(uncovered/lines),
               dead, percent(dead/lines));
        
    });

    printf("</table>\n");

    // Now output the annotated source code of each target
    options.targets.forEach(function(target) {
        var file = files[target];
        var srclines = fs.readFileSync(target, "utf8").split("\n");

        printf('<a name="%s"><h2>%s</h2></a>\n', target, target);
        srclines.forEach(function(srcline, linenum) {
            linenum += 1; // line numbers are 1-based, not 0-based
            var linedata = file.lines[linenum];
            var cov = file.coverageClass(linenum);
            var c = "line" + cov + file.profileClass(linenum);
            if (srcline === "") srcline = " "; // To make the HTML format right.
            if (cov) {
                if (cov === " full") {
                    var counts = linedata.counts();
                    cov = "// " + counts.join(",");
                }
                else
                    cov = "//" + cov;
            }
            printf('<div id="%s:%d" class="%s"><a href="#%s:%d" class="num">%d</a>' +
                   '<span class="type">%s</span>%s',
                   target, linenum, c, target, linenum, linenum, cov, srcline);

            if (options.outputops && linedata) {
                printf('<table class="ops hidden">');
                printf('<tr><th>Function @<th>PC<th>#<th>Instruction</tr>');
                for(pc in linedata.opcodes) {
                    var opcode = linedata.opcodes[pc];
                    var idx = pc.lastIndexOf(":");
                    printf("<tr><td>%s<td>%s<td>%d<td>%s</tr>",
                           pc.substring(0,idx),
                           pc.substring(idx+1),
                           opcode.count,
                           opcode.assembly);
                }
                printf("</table>");
            }
            printf("</div>\n");  // close the line div
        });
    });
    
    printf("</body>\n</html>\n");
    out.end();
}

function percent(x) { return (x*100).toFixed(1); }
