WITH const AS 
(
    --this line assumes you are playing the most recently created player race. replace if necessary.
    select max(RaceID) as RaceID from FCT_Race where NPR = 0
)
    
,DesignsToDelete AS
(    
    SELECT
        sc.*
    FROM
        FCT_ShipClass as sc
    inner JOIN
        const on sc.RaceID = const.RaceID
    left JOIN
        FCT_ShippingLines as s on s.ShippingLineID = sc.ClassShippingLineID
    WHERE
        sc.AutomatedDesignID > 0
    and
        s.ShippingLineID is null 
)
    
--run this first to check the results. should return a list of all designs to be deleted.
--select * from DesignsToDelete order by ClassName

--when satisfied with the above results, comment out the line above, uncomment the line below, and run the script again
delete from FCT_ShipClass where ShipClassID in (select ShipClassID from DesignsToDelete)
