import { smugmugRequest } from "./smugmug-client.mjs";

const match = process.argv[2];
const me = await smugmugRequest("/api/v2!authuser");
const albumsUri = me.Response.User.Uris.UserAlbums.Uri;
const albums = await smugmugRequest(`${albumsUri}?count=200`);
const album = (albums.Response.Album ?? []).find((a) => a.WebUri.includes(match));

if (!album) {
  console.error(`No album found matching "${match}"`);
  process.exit(1);
}
console.log(`Found: ${album.Name}  (${album.ImageCount} photos)\n${album.WebUri}\n`);

const imagesUri = album.Uris.AlbumImages.Uri;
const images = await smugmugRequest(`${imagesUri}?count=100`);
for (const img of images.Response.AlbumImage ?? []) {
  console.log(`${img.FileName}  |  ${img.WebUri}`);
  if (img.Uris?.ImageSizeDetails) {
    const sizes = await smugmugRequest(img.Uris.ImageSizeDetails.Uri);
    console.log(`  large: ${sizes.Response.ImageSizeDetails.LargeImageUrl}`);
  }
}
