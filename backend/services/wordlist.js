// Word library for memorable generated passwords — the source for the
// formula engine's word(min,max) generator (see services/formula.js).
//
// Curated by hand: common, easy-to-spell, inoffensive English words of 3–9
// lowercase letters (nature, food, animals, objects, music, colours,
// positive adjectives). No homophones-of-slurs, brand names or words that
// are awkward to read aloud over the phone. Add words freely — keep them
// lowercase a–z only; the loader drops anything else and de-duplicates.

const RAW = `
academy airplane alder almond amber anchor ant antelope anthem apple
apricot arc art ash aspen astronaut atlas avocado azure backpack badger
bagel bagpipe baker balcony ball ballad balloon bamboo banjo bark barn
barrel basil basket bass bay beach beacon beam bean bear beaver bee beet
bell berry bicycle bike binder birch biscuit bison blanket blossom blue
bluebell boat bold book bookcase boulder box brave breeze breezy bridge
bright brilliant bronze brook bucket buffalo builder bun bunny bus
butterfly button cab cabbage cabin cake calendar calm camel camellia camp
candle candy canoe canvas canyon cap captain car caramel caravan card
cardinal carnival carp carpenter carpet cashew castle cathedral cedar cello
chapel cheerful cheery cheetah chemist chestnut chip chorus cinema cinnamon
cipher citadel clam clarinet clay clever cliff cloud clover coast cobalt
cocoa coconut cod college colt comet compass concert cool copper coral corn
cosmic cottage cotton courtyard cove cozy crab crane crayon creek crimson
crow crystal cub cup cupboard cupcake curious curtain cushion cymbal
cypress daisy dancer daybreak dazzling deer delta denim desk diamond
diligent dock dolphin doodle door doorway dot dove dragonfly driftwood drum
drummer duck dumpling dune dusty eagle earnest easel echo eel egg elk elm
emerald emu engineer envelope eraser explorer fair faithful farm farmer
fearless fern ferry festival field fig finch fir firefly flamingo flannel
flute foam folder folk forest fortress fountain fox frog frost frosty fudge
fun gadget galaxy gallant gallery garden gardener gardenia gate gecko gem
generous gentle giraffe gizmo glacier glad glen globe glow glowing gnu goat
gold golden goldfish goose gorilla graceful gracious granite grape grassy
gravy gray grove guava guitar gust hail hallway hamlet hammock hamster
happy harbor hare harmonica harmony harp hat hawk hazel heather hedgehog
hen heron hibiscus highland hike hill hillside honest honey hop hopeful
horizon horn horse hue hum humble indigo ink inventor iron island ivory ivy
jade jam jar jasmine jay jazz jet jog jolly journal journey joy juggler
jump jungle juniper kale kangaroo kayak keen kettle key keychain kind
kingdom kite kitten kiwi knot koala koi lace ladder ladle ladybug lagoon
lake lamb lamp lane lantern laptop lark lavender leaf leafy leek lemon
lemonade leopard lettuce librarian library lilac lime linen lion lively
llama lobster lotus lowland loyal lucky lunar lute lynx lyric magazine
magenta magical magnolia mahogany mango map maple marble marigold marker
maroon mars marsh mast matrix meadow mellow melody melon merry mesa mill
mindful minstrel mint mirror mist misty mole monument moon moonbeam moose
moss mossy moth mountain muffin mug mule museum musician mystic navigator
navy neat nebula newt nimble noble nod noodles note notebook novel oak oar
oat obsidian ocean octopus olive onyx opal orb orbit orca orchard orchestra
orchid ore oregano organ otter owl paddle page painter palace palm pan
pancake panda panther parade park parsley pasta path patient pavilion pea
peaceful peach peacock peak peanut pear pearl pebble pelican pencil penguin
peninsula perch pewter piano picnic pie pier pies pillow pilot pine
pinecone pioneer pixel pizza planet platinum playful plucky plum pluto poem
pond pony popcorn poppy postcard pot potter powerful prairie prawn pretzel
primrose professor proud pug puma pumpkin puppy puzzle quail quartz quest
quiet radiant radish rain rainbow rainfall ram ranger rapid raven red reed
reef restful rhythm ribbon rice riddle ridge river riverbed road robin
robot rock rocket rocky root rope rose rosemary row ruby rudder rug run
russet safari saffron sage sail sailboat sailor salad salmon sand sandbar
sandwich sandy sapphire saturn saucer savanna scarlet scone scooter
sculptor sea seahorse seal seashell seashore seed serenade shark sheep
shining ship shore signal silk silver singer sip sketch skip sky slate
sleet snappy snow snowdrop snowfall sofa soft solar sole song sonnet soup
sparkly sparrow spin spinach splendid spoon sprocket squid squirrel
stairway stapler star starfish starlight steady stellar stony stork storm
story sturdy suitcase summit sun sunflower sunny sunrise sunset sunshine
swan swift swim symphony tablet tailor tan tap tart tea teal teapot temple
tender terrace thankful theater thunder thyme tide tidy tiger timeless tin
tireless titanium toad toast tomato topaz tortoise tower tractor train trek
trolley trombone trout trumpet tuba tulip tuna tundra tune tweed twilight
twinkly ukulele umbrella vale valiant valley van vanilla vector velvet
venus vibrant village vineyard violet violin viper vivid volcano voyage
waffle wagon walk walnut warm wasp waterfall wave weaver whale whisk widget
willow wind windmill window wise witty wolf woodland woody wool wren
xylophone yacht yak yam yarn yew youthful zebra zen zesty zinc zip`;

const WORDS = Array.from(new Set(RAW.split(/\s+/).filter((w) => /^[a-z]+$/.test(w))));

// Bucket by length once so word(min,max) is a cheap pick.
const BY_LEN = new Map();
for (const w of WORDS) {
  if (!BY_LEN.has(w.length)) BY_LEN.set(w.length, []);
  BY_LEN.get(w.length).push(w);
}

// All words whose length is within [min, max] (inclusive).
function wordsBetween(min, max) {
  const out = [];
  for (let l = min; l <= max; l++) if (BY_LEN.has(l)) out.push(...BY_LEN.get(l));
  return out;
}

const MIN_LEN = Math.min(...BY_LEN.keys());
const MAX_LEN = Math.max(...BY_LEN.keys());

module.exports = { WORDS, wordsBetween, MIN_LEN, MAX_LEN };
