# Requirements: Sipariş yönetimi

1. Müşterileri her biri için farklı bir müşteri numarası ve ad ile kaydediniz.
2. Bir müşteri hiç teslimat adresi saklamayabilir veya istediği kadar teslimat adresi saklayabilir; aynı müşteri birden fazla adres kullanabilir.
3. Her teslimat adresinde il, ilçe ve açık adres bilgileri ayrı ayrı bulunur; bunlar birlikte tek bir teslimat adresini oluşturur.
4. Ürünleri her biri için farklı bir ürün kodu ve ad ile kaydediniz.
5. Her siparişin diğer siparişlerden farklı bir sipariş numarası ve tarihi vardır.
6. Her sipariş tam olarak bir müşteriye aittir; bir müşteri hiç sipariş vermemiş olabilir veya istediği kadar sipariş verebilir.
7. Her siparişte en az bir satır bulunur ve satır sayısına üst sınır yoktur; her satır tam olarak bir siparişe aittir.
8. Satır numarası yalnızca kendi siparişi içinde ayırt edicidir; başka siparişlerde aynı numara kullanılabilir, aynı siparişte kullanılamaz; her satırın miktarı ve birim fiyatı saklanır.
9. Her satır tam olarak bir ürünü gösterir; bir ürün hiçbir satırda bulunmayabilir veya istediği kadar satırda bulunabilir.
10. Siparişin toplam tutarı satırlardaki miktar ve birim fiyat çarpımlarının toplamından hesaplanır, ayrıca elle girilmez.
11. Kuryeleri her biri için farklı bir kurye numarası ve ad ile kaydediniz.
12. Her sipariş henüz teslim edilmemiş olabilir veya en fazla bir kuryeyle teslim edilir; bir kurye hiç sipariş taşımamış olabilir veya istediği kadar sipariş taşıyabilir.
