# Gereksinimler: Mağaza

1. MÜŞTERİ varlığı MüşteriNo ile benzersiz tanımlanır ve Adı niteliğini kaydeder.
2. ÜRÜN varlığı ÜrünKodu ile benzersiz tanımlanır ve Açıklama ile Fiyat niteliklerini kaydeder.
3. SİPARİŞ varlığı SiparişNo ile benzersiz tanımlanır ve Tarih niteliğini kaydeder.
4. Her SİPARİŞ tam olarak bir MÜŞTERİ tarafından verilir; bir MÜŞTERİ sıfır veya herhangi bir sayıda sipariş verebilir.
5. Her SİPARİŞ en az bir ÜRÜN içerir ve herhangi bir sayıda ürün içerebilir; bir ÜRÜN sıfır veya herhangi bir sayıda siparişte yer alabilir.
6. İÇERİR ilişkisi her sipariş-ürün çifti için Adet niteliğini kaydeder.
